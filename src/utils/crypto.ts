import { createDecipheriv } from "node:crypto";

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

