import { webcrypto } from "node:crypto";

/**
 * People log in through Cloudflare Access, which puts a signed token (a JWT)
 * on every request it lets through. Trusting the tunnel alone would make the
 * whole page as safe as the Access settings; checking the token here means a
 * mistake there — a policy left open, a request that reaches the server some
 * other way — still gets nobody in. The token must be signed by the team's
 * current keys, meant for this application, unexpired, and name a person on
 * UI_USERS. Service tokens carry no person, so they never get the page.
 */

type Jwk = webcrypto.JsonWebKey & { kid?: string };

/** Who a valid Access token names, and when they logged in. */
export type AccessPerson = {
  email: string;
  /** On UI_USERS. A person Access let in who is not on the list gets nothing. */
  allowed: boolean;
  /** Seconds since 1970: the login this token came from. */
  issuedAt: number;
  expiresAt: number;
  country?: string;
};

export type AccessConfig = {
  teamDomain: string;
  audience: string;
  users: readonly string[];
  /** Fetching the team's keys; tests pass their own. */
  fetchImpl?: typeof fetch;
  now?: () => number;
};

const decoder = new TextDecoder();
const fromB64url = (part: string) => Buffer.from(part, "base64url");

export function accessVerifier(config: AccessConfig) {
  const fetchImpl = config.fetchImpl ?? fetch;
  const now = config.now ?? Date.now;
  const issuer = `https://${config.teamDomain}`;
  const users = new Set(config.users.map((user) => user.toLowerCase()));
  let keys = new Map<string, webcrypto.CryptoKey>();
  let fetchedAt = 0;

  async function refresh() {
    const response = await fetchImpl(`${issuer}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Access keys: HTTP ${response.status}`);
    const body = (await response.json()) as { keys?: Jwk[] };
    const next = new Map<string, webcrypto.CryptoKey>();
    for (const jwk of body.keys ?? []) {
      if (!jwk.kid || jwk.kty !== "RSA") continue;
      next.set(
        jwk.kid,
        await webcrypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]),
      );
    }
    keys = next;
    fetchedAt = now();
  }

  async function keyFor(kid: string) {
    // Keys are kept for an hour; an unknown key id fetches again, but at most
    // once a minute, so a stream of forged ids cannot hammer Cloudflare.
    if (now() - fetchedAt > 60 * 60_000 || (!keys.has(kid) && now() - fetchedAt > 60_000)) await refresh();
    return keys.get(kid);
  }

  /**
   * The person, when the token is good: `allowed` says whether they are on
   * UI_USERS. Undefined for anything that is not a valid token for this
   * application, including a service token, which names no person.
   */
  return async function verify(token: string | undefined): Promise<AccessPerson | undefined> {
    if (!token || token.length > 8192) return undefined;
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    try {
      const header = JSON.parse(decoder.decode(fromB64url(parts[0]!))) as { alg?: string; kid?: string };
      if (header.alg !== "RS256" || !header.kid) return undefined;
      const key = await keyFor(header.kid);
      if (!key) return undefined;
      const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
      const valid = await webcrypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromB64url(parts[2]!), signed);
      if (!valid) return undefined;

      const claims = JSON.parse(decoder.decode(fromB64url(parts[1]!))) as {
        iss?: string;
        aud?: string | string[];
        exp?: number;
        nbf?: number;
        iat?: number;
        email?: string;
        country?: string;
      };
      const seconds = now() / 1000;
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (claims.iss !== issuer || !audiences.includes(config.audience)) return undefined;
      if (typeof claims.exp !== "number" || claims.exp < seconds - 30) return undefined;
      if (typeof claims.nbf === "number" && claims.nbf > seconds + 30) return undefined;
      const email = claims.email?.toLowerCase();
      if (!email) return undefined;
      return {
        email,
        allowed: users.has(email),
        issuedAt: typeof claims.iat === "number" ? claims.iat : 0,
        expiresAt: claims.exp,
        country: typeof claims.country === "string" ? claims.country.slice(0, 2) : undefined,
      };
    } catch {
      return undefined;
    }
  };
}
