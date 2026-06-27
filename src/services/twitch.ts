import { createDecipheriv, createCipheriv, randomBytes } from "crypto";
import { supabase } from "../clients/supabase";
import { log } from "../utils/logger";

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY;

function decryptToken(ciphertext: string, iv: string, authTag: string): string {
  if (!TOKEN_ENCRYPTION_KEY) throw new Error("TOKEN_ENCRYPTION_KEY is not set");
  const key = Buffer.from(TOKEN_ENCRYPTION_KEY, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(authTag, "base64"));
  return decipher.update(ciphertext, "base64", "utf8") + decipher.final("utf8");
}

function encryptToken(plaintext: string): { ciphertext: string; iv: string; authTag: string } {
  if (!TOKEN_ENCRYPTION_KEY) throw new Error("TOKEN_ENCRYPTION_KEY is not set");
  const key = Buffer.from(TOKEN_ENCRYPTION_KEY, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = cipher.update(plaintext, "utf8", "base64") + cipher.final("base64");
  return { ciphertext, iv: iv.toString("base64"), authTag: cipher.getAuthTag().toString("base64") };
}

async function fetchStreamKey(twitchUserId: string, accessToken: string): Promise<string> {
  const res = await fetch(
    `https://api.twitch.tv/helix/streams/key?broadcaster_id=${twitchUserId}`,
    {
      headers: {
        "Client-Id": TWITCH_CLIENT_ID ?? "",
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw Object.assign(new Error(`Twitch API error ${res.status}: ${body}`), { status: res.status });
  }

  const json = (await res.json()) as { data: { stream_key: string }[] };
  const key = json.data[0]?.stream_key;
  if (!key) throw new Error("No stream key returned by Twitch API");
  return key;
}

async function refreshUserToken(
  userId: string,
  refreshToken: string
): Promise<string> {
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
    throw new Error("TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET must be set");
  }

  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: TWITCH_CLIENT_ID,
      client_secret: TWITCH_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Token refresh failed ${res.status}: ${body}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  // Encrypt and persist the new tokens
  const encAccess = encryptToken(data.access_token);
  const encRefresh = encryptToken(data.refresh_token);

  const { error } = await supabase
    .from("integrations_twitch")
    .update({
      access_token_ciphertext: encAccess.ciphertext,
      access_token_iv: encAccess.iv,
      access_token_tag: encAccess.authTag,
      refresh_token_ciphertext: encRefresh.ciphertext,
      refresh_token_iv: encRefresh.iv,
      refresh_token_tag: encRefresh.authTag,
    })
    .eq("user_id", userId);

  if (error) log("warn", "failed to persist refreshed Twitch tokens", { userId, error: error.message });

  return data.access_token;
}

// Fetches the Twitch stream key for a user. Returns null on any failure so
// callers can treat it as non-fatal (OBS will just show the "Use Stream Key"
// screen instead of auto-populating it).
export async function getStreamKey(userId: string): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from("integrations_twitch")
      .select(
        "twitch_user_id, access_token_ciphertext, access_token_iv, access_token_tag, refresh_token_ciphertext, refresh_token_iv, refresh_token_tag"
      )
      .eq("user_id", userId)
      .single();

    if (error || !data) {
      log("warn", "no Twitch integration found for user, skipping stream key injection", { userId });
      return null;
    }

    const {
      twitch_user_id,
      access_token_ciphertext,
      access_token_iv,
      access_token_tag,
      refresh_token_ciphertext,
      refresh_token_iv,
      refresh_token_tag,
    } = data;

    let accessToken = decryptToken(access_token_ciphertext, access_token_iv, access_token_tag);

    try {
      return await fetchStreamKey(twitch_user_id, accessToken);
    } catch (err: any) {
      if (err?.status !== 401) throw err;

      // Token expired — refresh and retry once
      log("info", "Twitch access token expired, refreshing", { userId });
      const refreshToken = decryptToken(refresh_token_ciphertext, refresh_token_iv, refresh_token_tag);
      accessToken = await refreshUserToken(userId, refreshToken);
      return await fetchStreamKey(twitch_user_id, accessToken);
    }
  } catch (err) {
    log("warn", "failed to fetch Twitch stream key, continuing without it", {
      userId,
      error: (err as Error).message,
    });
    return null;
  }
}
