import { test } from "vitest";
import assert from "node:assert/strict";
import {
  decodeExchangeToken,
  newRequestId,
  passwordHash,
  requestSignature,
  requestSignatureWithInvoices,
  requestTimestamp,
  signatureTimestamp,
} from "../src/crypto.js";

/**
 * The expected values here were computed with OpenSSL, not with this code, so
 * a mistake in the composition shows up rather than being confirmed:
 *
 *   printf 'Titkos123' | openssl dgst -sha512
 *   printf 'TESZT120260922120000ab12cd34ef56' | openssl dgst -sha3-512
 */

test("the password goes as an uppercase SHA-512", () => {
  assert.equal(
    passwordHash("Titkos123"),
    "B632488E9FC9E59C0E11D5A9383C1D9DD2404C71CDB0A2913AFD939D90D6CF2452FFE7D758E09BB1E1C71062761959AEADB4B25BE3C9D8224BED9646A6FBCFC3",
  );
});

test("the hash is SHA3-512 and not Keccak, which are different functions", () => {
  // Signing nothing but the epoch hashes the string "19700101000000".
  //   printf '19700101000000' | openssl dgst -sha3-512   -> 0d7fb32d...
  //   printf '19700101000000' | openssl dgst -keccak-512 -> e4dcb144...
  // An implementation on the wrong one of the two would pass every other test
  // here and be rejected by NAV on the first request.
  const signed = requestSignature({
    requestId: "",
    timestamp: new Date("1970-01-01T00:00:00Z"),
    signingKey: "",
  });
  assert.match(signed, /^0D7FB32DCD2363D838A1EB773B3C978E/);
  assert.doesNotMatch(signed, /^E4DCB1443A43261658F6/);
});

test("the timestamp is masked as NAV wants it, in UTC", () => {
  const moment = new Date("2026-09-22T12:00:00.000Z");
  assert.equal(signatureTimestamp(moment), "20260922120000");
  assert.equal(requestTimestamp(moment), "2026-09-22T12:00:00Z");
  // A moment given in local time still masks to its UTC face.
  assert.equal(signatureTimestamp(new Date("2026-01-02T00:30:00+01:00")), "20260101233000");
});

test("a plain request signs the id, the masked timestamp and the signing key", () => {
  assert.equal(
    requestSignature({
      requestId: "TESZT1",
      timestamp: new Date("2026-09-22T12:00:00Z"),
      signingKey: "ab12cd34ef56",
    }),
    "77AE20A91E0EC99055E8EE3F496C4DE5DF03291AE07448CACB62A71744399D7B59A0B710A964BDC5F9D843B7DF2F3106D96C7E62F930A8805FD7A1173304A6DE",
  );
});

test("sending invoices signs what is sent, in index order", () => {
  const parts = {
    requestId: "TESZT1",
    timestamp: new Date("2026-09-22T12:00:00Z"),
    signingKey: "ab12cd34ef56",
  };
  const first = { operation: "CREATE", base64: "PHhtbC8+" };
  const second = { operation: "STORNO", base64: "PG1hcy8+" };

  const signed = requestSignatureWithInvoices(parts, [first, second]);
  assert.match(signed, /^[0-9A-F]{128}$/);
  // The order is part of what is signed: swapping the two must not match.
  assert.notEqual(signed, requestSignatureWithInvoices(parts, [second, first]));
  // And it is not the same as the signature of the request alone.
  assert.notEqual(signed, requestSignature(parts));
});

test("a request cannot claim to send invoices and send none", () => {
  const parts = {
    requestId: "TESZT1",
    timestamp: new Date("2026-09-22T12:00:00Z"),
    signingKey: "key",
  };
  assert.throws(() => requestSignatureWithInvoices(parts, []), /at least one invoice/);
  assert.throws(
    () =>
      requestSignatureWithInvoices(
        parts,
        Array.from({ length: 101 }, () => ({ operation: "CREATE", base64: "eA==" })),
      ),
    /at most 100/,
  );
});

test("the token is decrypted with the exchange key", () => {
  // Encrypted by OpenSSL with the algorithm NAV uses, so this proves the
  // decryption rather than assuming it:
  //   printf 'token-abc123' | openssl enc -aes-128-ecb \
  //     -K 30313233343536373839616263646566 -base64
  assert.equal(decodeExchangeToken("gPosf78y3mFr/biK1lCLEw==", "0123456789abcdef"), "token-abc123");
});

test("a key of the wrong length is refused before it reaches the cipher", () => {
  assert.throws(() => decodeExchangeToken("gPosf78y3mFr/biK1lCLEw==", "too-short"), /16 bytes/);
});

test("a token decrypted with the wrong key does not come back as the token", () => {
  let decoded: string | undefined;
  try {
    decoded = decodeExchangeToken("gPosf78y3mFr/biK1lCLEw==", "fedcba9876543210");
  } catch {
    // Padding that does not check out throws, which is the other right answer.
    return;
  }
  assert.notEqual(decoded, "token-abc123");
});

test("a request id is unique and within the pattern", () => {
  const moment = new Date("2026-09-22T12:00:00Z");
  assert.equal(newRequestId(moment, () => "ABCD1234"), "RQ20260922120000ABCD1234");
  assert.match(newRequestId(moment), /^[0-9A-Z]{1,30}$/);
  assert.notEqual(newRequestId(moment), newRequestId(moment));
});

test("text XML cannot carry is refused, not quietly changed", async () => {
  const { escapeXml, InvalidXmlText } = await import("../src/xml.js");
  assert.equal(escapeXml(`Kiss & Fia <Kft.> "idézet" 'x'`), "Kiss &amp; Fia &lt;Kft.&gt; &quot;idézet&quot; &apos;x&apos;");
  assert.equal(escapeXml("tab\tsor\nvég"), "tab\tsor\nvég");
  assert.equal(escapeXml("emoji 😀 is fine"), "emoji 😀 is fine");
  for (const bad of ["null\u0000byte", "bell\u0007", "lone \uD800 surrogate", "￾"]) {
    assert.throws(() => escapeXml(bad), InvalidXmlText);
  }
});
