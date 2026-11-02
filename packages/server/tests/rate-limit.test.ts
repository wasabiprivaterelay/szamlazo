import { test } from "vitest";
import assert from "node:assert/strict";
import { rateLimiter } from "../src/http/rate-limit.js";
import { hashKey, newApiKey, verifyKey, bearerOf } from "../src/http/auth.js";

test("a client is let through up to the limit, then refused until the window passes", () => {
  let now = 0;
  const allow = rateLimiter({ max: 3, perMs: 1000 }, () => now);
  assert.deepEqual([allow("a"), allow("a"), allow("a"), allow("a")], [true, true, true, false]);
  assert.equal(allow("b"), true, "another client has its own count");
  now = 1001;
  assert.equal(allow("a"), true);
});

test("a flood of distinct clients cannot grow the limiter without bound", () => {
  const allow = rateLimiter({ max: 5, perMs: 60_000 }, () => 0);
  for (let i = 0; i < 50_000; i++) allow(`10.0.${i >> 8}.${i & 255}-${i}`);
  // Nothing to observe from outside but that it finished and still works.
  assert.equal(allow("fresh"), true);
});

test("API keys: only the exact key matches, and only its hash is ever stored", () => {
  const { key, hash } = newApiKey();
  assert.match(key, /^szk_[A-Za-z0-9_-]{43}$/);
  assert.equal(hash, hashKey(key));
  assert.ok(!hash.includes(key.slice(4, 12)));
  const keys = [{ name: "shop", hash }, { name: "other", hash: hashKey("szk_other") }];
  assert.equal(verifyKey(key, keys), "shop");
  assert.equal(verifyKey(`${key}x`, keys), undefined);
  assert.equal(verifyKey(key.slice(4), keys), undefined, "without the prefix");
  assert.equal(verifyKey(undefined, keys), undefined);
  assert.equal(verifyKey(`szk_${"a".repeat(500)}`, keys), undefined, "absurdly long");
  assert.equal(bearerOf(`Bearer ${key}`), key);
  assert.equal(bearerOf(`Basic ${key}`), undefined);
});
