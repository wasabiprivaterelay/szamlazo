import { test } from "vitest";
import assert from "node:assert/strict";
import { NavConfigError, credentialsFromEnv, hasNavCredentials, softwareFromEnv, taxpayerIdOf } from "../src/env.js";

const env = {
  NAV_LOGIN: "abcdef123456789",
  NAV_PASSWORD: "jelszo",
  NAV_SIGNING_KEY: "ab-cd-ef",
  NAV_EXCHANGE_KEY: "0123456789abcdef",
  NAV_TAX_NUMBER: "12345678-2-41",
  NAV_SOFTWARE_DEV_NAME: "Minta Bt.",
  NAV_SOFTWARE_DEV_CONTACT: "dev@example.com",
};

test("a tax number is taken in any of its usual spellings, as its first eight digits", () => {
  assert.equal(taxpayerIdOf("12345678"), "12345678");
  assert.equal(taxpayerIdOf("12345678-2-41"), "12345678");
  assert.equal(taxpayerIdOf("12345678241"), "12345678");
  assert.throws(() => taxpayerIdOf("1234567"), NavConfigError);
  assert.throws(() => taxpayerIdOf("12345678-2"), NavConfigError);
});

test("missing credentials are named, never guessed", () => {
  assert.equal(hasNavCredentials(env), true);
  assert.equal(hasNavCredentials({ ...env, NAV_PASSWORD: " " }), false);
  assert.throws(() => credentialsFromEnv({ ...env, NAV_LOGIN: undefined, NAV_EXCHANGE_KEY: "" }), /NAV_LOGIN, NAV_EXCHANGE_KEY/);
  assert.equal(credentialsFromEnv(env).taxNumber, "12345678");
});

test("the software id defaults to the tax number and fits NAV's 18 characters", () => {
  const software = softwareFromEnv(env, { version: "0.1.0" });
  assert.equal(software.softwareId, "12345678SZAMLAZO-1");
  assert.equal(software.softwareId.length, 18);
  assert.equal(software.softwareMainVersion, "0.1.0");
  assert.equal(softwareFromEnv({ ...env, NAV_SOFTWARE_ID: "ABCDEFGHIJKLMNOPQR" }).softwareId, "ABCDEFGHIJKLMNOPQR");
  assert.throws(() => softwareFromEnv({ ...env, NAV_SOFTWARE_DEV_CONTACT: "" }), /NAV_SOFTWARE_DEV_CONTACT/);
  assert.throws(() => softwareFromEnv({ ...env, NAV_SOFTWARE_OPERATION: "CLOUD" }), /ONLINE_SERVICE/);
});
