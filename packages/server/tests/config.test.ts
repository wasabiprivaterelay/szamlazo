import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, readEnv } from "../src/env.js";
import { bearerOf, newApiKey, verifyKey } from "../src/http/auth.js";
import { readLogo } from "../src/services.js";
import { invoicePath, localStore, objectStore } from "../src/storage.js";
import { BASE_ENV } from "./helpers.js";

const NAV = {
  NAV_LOGIN: "abcdef123456789",
  NAV_PASSWORD: "jelszo",
  NAV_SIGNING_KEY: "sign",
  NAV_EXCHANGE_KEY: "0123456789abcdef",
  NAV_TAX_NUMBER: "12345678",
  NAV_SOFTWARE_DEV_NAME: "Minta Bt.",
  NAV_SOFTWARE_DEV_CONTACT: "dev@example.com",
};
const KEY = `webshop:${"a".repeat(64)}`;

test("a missing or malformed setting stops the start, naming the variable", () => {
  assert.throws(() => readEnv({ ...BASE_ENV, SELLER_TAX_NUMBER: "12345678" }), /SELLER_TAX_NUMBER/);
  assert.throws(() => readEnv({ ...BASE_ENV, INVOICE_PREFIX: "sz" }), /INVOICE_PREFIX/);
  assert.throws(() => readEnv({ ...BASE_ENV, API_KEYS: "webshop:plaintext-key" }), /API_KEYS/);
  assert.throws(() => readEnv({ ...BASE_ENV, API_KEYS: `${KEY},${KEY}` }), /same name/);
  assert.throws(() => readEnv({ ...BASE_ENV, STORAGE: "s3" }), /S3_ENDPOINT, S3_BUCKET/);
  assert.throws(() => readEnv({ ...BASE_ENV, SELLER_NAME: "" }), ConfigError);
});

test("production reports to NAV's live system and nothing else does", () => {
  assert.throws(() => readEnv({ ...BASE_ENV, ENVIRONMENT: "production", API_KEYS: KEY }), /technical user/);
  assert.throws(
    () => readEnv({ ...BASE_ENV, ...NAV, ENVIRONMENT: "production", API_KEYS: KEY, NAV_ENVIRONMENT: "test" }),
    /NAV_ENVIRONMENT=production/,
  );
  assert.throws(() => readEnv({ ...BASE_ENV, ...NAV, ENVIRONMENT: "staging", NAV_ENVIRONMENT: "production" }), /only ENVIRONMENT=production/);
  assert.throws(() => readEnv({ ...BASE_ENV, ...NAV, ENVIRONMENT: "production", NAV_ENVIRONMENT: "production" }), /API key/);
  const live = readEnv({ ...BASE_ENV, ...NAV, ENVIRONMENT: "production", NAV_ENVIRONMENT: "production", API_KEYS: KEY });
  assert.equal(live.nav.environment, "production");
});

test("the NAV technical user must belong to the seller", () => {
  assert.throws(() => readEnv({ ...BASE_ENV, ...NAV, NAV_TAX_NUMBER: "87654321" }), /different taxpayers/);
});

test("API keys: verified against their hashes, a wrong one is not, and only Bearer is read", () => {
  const one = newApiKey();
  const two = newApiKey();
  const keys = [
    { name: "webshop", hash: one.hash },
    { name: "accounting", hash: two.hash },
  ];
  assert.match(one.key, /^szk_[A-Za-z0-9_-]{43}$/);
  assert.equal(verifyKey(one.key, keys), "webshop");
  assert.equal(verifyKey(two.key, keys), "accounting");
  assert.equal(verifyKey(`${one.key}x`, keys), undefined);
  assert.equal(verifyKey(one.hash, keys), undefined, "the hash itself is not a key");
  assert.equal(verifyKey(undefined, keys), undefined);
  assert.equal(bearerOf(`Bearer ${one.key}`), one.key);
  assert.equal(bearerOf(one.key), undefined);
});

test("the local store writes only the paths it makes, and never outside its folder", async () => {
  const folder = mkdtempSync(join(tmpdir(), "szamlazo-store-"));
  const store = localStore(folder);
  const path = invoicePath("SZ2026/00042", 2026);
  assert.equal(path, "invoices/2026/SZ2026-00042.pdf");
  const stored = await store.put(path, new Uint8Array([1, 2, 3]));
  assert.equal(stored.bytes, 3);
  assert.deepEqual([...(await store.get(path))], [1, 2, 3]);
  await store.probe!();
  for (const bad of ["../../etc/passwd", "invoices/2026/../../x.pdf", "/etc/passwd", "invoices/2026/a.pdf"]) {
    await assert.rejects(store.get(bad), /refusing/);
    await assert.rejects(store.put(bad, new Uint8Array()), /refusing/);
  }
  assert.throws(() => invoicePath("../SZ2026/1", 2026));
});

test("the bucket store signs its requests and checks the bytes it sends", async () => {
  const seen: Request[] = [];
  const store = objectStore(
    { endpoint: "https://account.r2.cloudflarestorage.com", bucket: "invoices", accessKeyId: "id", secretAccessKey: "secret" },
    async (input) => {
      seen.push(input as Request);
      return new Response(null, { status: 200 });
    },
  );
  await store.put("invoices/2026/SZ2026-00001.pdf", new Uint8Array([1, 2, 3]));
  const request = seen[0]!;
  assert.equal(request.method, "PUT");
  assert.equal(request.url, "https://account.r2.cloudflarestorage.com/invoices/invoices/2026/SZ2026-00001.pdf");
  assert.match(request.headers.get("authorization") ?? "", /^AWS4-HMAC-SHA256 Credential=id\//);
  assert.equal(request.headers.get("x-amz-content-sha256"), "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81");
  await assert.rejects(store.put("../escape.pdf", new Uint8Array()), /refusing/);
});

test("the logo must really be a PNG or JPEG", () => {
  const folder = mkdtempSync(join(tmpdir(), "szamlazo-logo-"));
  const fake = join(folder, "logo.png");
  writeFileSync(fake, "<svg onload=alert(1)>");
  assert.throws(() => readLogo(fake), /PNG or JPEG/);
  const png = join(folder, "real.png");
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  assert.equal(readLogo(png).length, 8);
});
