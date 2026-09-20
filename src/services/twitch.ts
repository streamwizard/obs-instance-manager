import { apiGetStreamKey, type StreamKeyLookup } from "../clients/streamwizard-api";
import { log } from "../utils/logger";

/** The user has not granted StreamWizard their stream key on Twitch. */
export class StreamKeyNotGrantedError extends Error {
  readonly code = "stream_key_not_granted";
  constructor() {
    super("Connect Twitch on the cloud OBS page first so this instance can stream with your key.");
  }
}

export async function getStreamKey(userId: string): Promise<StreamKeyLookup> {
  return apiGetStreamKey(userId);
}

/**
 * The stream key a boot may proceed with. Throws StreamKeyNotGrantedError
 * when Twitch has not handed the key over: an instance booted without it
 * comes up keyless and the user only finds out when Go Live fails. A lookup
 * failure on rest-api's side (`error`) is not the user's doing, so that path
 * still boots keyless with a warning instead of locking them out.
 */
export async function requireStreamKey(userId: string): Promise<string | null> {
  const lookup = await getStreamKey(userId);
  if (lookup.reason === "scope_missing" || lookup.reason === "no_integration") {
    throw new StreamKeyNotGrantedError();
  }
  if (lookup.reason === "error" || !lookup.key) {
    log("warn", "stream key unavailable, booting without one", { userId, reason: lookup.reason });
    return null;
  }
  return lookup.key;
}
