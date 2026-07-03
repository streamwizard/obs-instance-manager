import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const key = process.env.TOKEN_ENCRYPTION_KEY;
if (!key) throw new Error("TOKEN_ENCRYPTION_KEY must be set");
const encryptionKey = key;

export function decryptPassword(ciphertext: string, iv: string, authTag: string): string {
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(encryptionKey, "hex"), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(authTag, "base64"));
  let plaintext = decipher.update(ciphertext, "base64", "utf8");
  plaintext += decipher.final("utf8");
  return plaintext;
}

export interface EncryptedPassword {
  ciphertext: string;
  iv: string;
  tag: string;
}

// Unlike decryptPassword above (used for client-encrypted secrets like the OBS
// WS password), this is for server-generated secrets -- e.g. the per-instance
// VNC password -- that never need to leave this process in plaintext except to
// pass into the container's env at create/start time.
export function encryptPassword(plaintext: string): EncryptedPassword {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(encryptionKey, "hex"), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

export function generateVncPassword(): string {
  return randomBytes(18).toString("base64");
}

