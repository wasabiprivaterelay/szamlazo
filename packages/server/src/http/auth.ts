import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * API keys. A key is 32 random bytes, shown once when it is made; the server
 * keeps only its SHA-256, so the configuration, a backup or a log line can
 * never give a working key away. A presented key is hashed and compared with
 * every stored hash in constant time, so how long a refusal takes says
 * nothing about how close a guess was.
 */

export type ApiKey = { name: string; hash: string };

const PREFIX = "szk_";

export function hashKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function newApiKey(): { key: string; hash: string } {
  const key = `${PREFIX}${randomBytes(32).toString("base64url")}`;
  return { key, hash: hashKey(key) };
}

/** The key's name when the presented key matches one, otherwise undefined. */
export function verifyKey(presented: string | undefined, keys: readonly ApiKey[]): string | undefined {
  if (!presented || !presented.startsWith(PREFIX) || presented.length > 200) return undefined;
  const candidate = Buffer.from(hashKey(presented), "hex");
  let match: string | undefined;
  // Every key is compared, match or not, so the time taken does not depend on which matched.
  for (const key of keys) {
    const stored = Buffer.from(key.hash, "hex");
    if (stored.length === candidate.length && timingSafeEqual(stored, candidate)) match ??= key.name;
  }
  return match;
}

/** "Bearer szk_…" → "szk_…". */
export function bearerOf(header: string | undefined): string | undefined {
  const found = header?.match(/^Bearer\s+(\S+)$/i);
  return found?.[1];
}
