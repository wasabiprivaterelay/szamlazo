import { createHash, createDecipheriv, randomInt } from "node:crypto";

/**
 * The authentication NAV's Online Számla interface asks for. Every rule here
 * comes from the v3.0 specification, sections 1.3.2 and 1.5, and each is
 * covered by a test against values computed with OpenSSL rather than with
 * this code.
 */

/** Uppercase hex, which is what NAV compares against. */
function hash(algorithm: "sha512" | "sha3-512", input: string): string {
  return createHash(algorithm).update(input, "utf8").digest("hex").toUpperCase();
}

/**
 * The technical user's password, as the passwordHash tag wants it: an
 * uppercase SHA-512. The literal password never leaves the caller.
 */
export function passwordHash(password: string): string {
  return hash("sha512", password);
}

/**
 * The timestamp as the signature wants it: UTC, yyyyMMddHHmmss, with the
 * separators and the zone taken out. The same moment goes into the request's
 * own timestamp tag in ISO form, so the two must be built from one Date.
 */
export function signatureTimestamp(moment: Date): string {
  return moment.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

/** The timestamp as the request header wants it: ISO 8601, UTC, to the second. */
export function requestTimestamp(moment: Date): string {
  return `${moment.toISOString().slice(0, 19)}Z`;
}

export type SignatureParts = {
  requestId: string;
  /** The same moment as the request's timestamp tag. */
  timestamp: Date;
  /** The technical user's signing key, as the portal shows it. */
  signingKey: string;
};

/**
 * For every operation except manageInvoice and manageAnnulment, the signature
 * is the SHA3-512 of the request id, the masked timestamp and the signing key,
 * concatenated in that order (specification 1.5.2).
 */
export function requestSignature({ requestId, timestamp, signingKey }: SignatureParts): string {
  return hash("sha3-512", `${requestId}${signatureTimestamp(timestamp)}${signingKey}`);
}

export type SignedInvoice = {
  /** CREATE, MODIFY, STORNO — or ANNUL for an annulment. */
  operation: string;
  /** The invoice XML, already base64 encoded, exactly as it is sent. */
  base64: string;
};

/**
 * For manageInvoice and manageAnnulment the signature covers what is being
 * sent as well (specification 1.5.1): the same three values, followed by one
 * uppercase SHA3-512 per index over the operation and the base64 content, all
 * concatenated and hashed again.
 *
 * The invoices must be given in index order, because their order is what the
 * server hashes.
 */
export function requestSignatureWithInvoices(
  parts: SignatureParts,
  invoices: readonly SignedInvoice[],
): string {
  if (invoices.length === 0) {
    throw new Error("manageInvoice signs what it sends, so it needs at least one invoice");
  }
  if (invoices.length > 100) {
    throw new Error(`a request carries at most 100 invoices, got ${invoices.length}`);
  }

  const partial = `${parts.requestId}${signatureTimestamp(parts.timestamp)}${parts.signingKey}`;
  const perInvoice = invoices
    .map((invoice) => hash("sha3-512", `${invoice.operation}${invoice.base64}`))
    .join("");
  return hash("sha3-512", `${partial}${perInvoice}`);
}

/**
 * The token that tokenExchange returns is encrypted with the technical user's
 * exchange key; manageInvoice wants the decrypted value, and the encrypted one
 * is good for nothing (specification, tokenExchange). AES-128 in ECB mode, as
 * NAV specifies — their choice, not ours: the payload is a short token, and
 * the mode is what the server encrypts with.
 */
export function decodeExchangeToken(encodedBase64: string, exchangeKey: string): string {
  const key = Buffer.from(exchangeKey, "utf8");
  if (key.byteLength !== 16) {
    throw new Error(`the exchange key must be 16 bytes for AES-128, got ${key.byteLength}`);
  }
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([
    decipher.update(Buffer.from(encodedBase64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * A request id: unique per taxpayer within the timestamp's tolerance, and
 * within the pattern NAV allows ([+a-zA-Z0-9_]{1,30}). The date in front
 * makes a duplicate practically impossible and a log readable; the random
 * part comes from the operating system's secure generator, so ids cannot be
 * predicted from one another.
 */
export function newRequestId(moment: Date = new Date(), random = randomSuffix): string {
  return `RQ${signatureTimestamp(moment)}${random()}`;
}

function randomSuffix(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let suffix = "";
  for (let index = 0; index < 8; index++) {
    suffix += alphabet[randomInt(alphabet.length)];
  }
  return suffix;
}
