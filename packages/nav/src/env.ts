import { NavClient } from "./client.js";
import type { NavCredentials, NavEnvironment, SoftwareDescription } from "./config.js";

/**
 * The NAV settings as environment variables, so a program, a script and the
 * command line all read them the same way. Every name is listed in the
 * repository's .env.example with a sentence on where its value comes from.
 */

export type EnvSource = Readonly<Record<string, string | undefined>>;

const CREDENTIALS = ["NAV_LOGIN", "NAV_PASSWORD", "NAV_SIGNING_KEY", "NAV_EXCHANGE_KEY", "NAV_TAX_NUMBER"] as const;

/** Thrown when something the NAV client cannot work without is missing or malformed. */
export class NavConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NavConfigError";
  }
}

const present = (value: string | undefined): value is string => value !== undefined && value.trim() !== "";

/** Whether the five technical-user values are all set. */
export function hasNavCredentials(env: EnvSource): boolean {
  return CREDENTIALS.every((name) => present(env[name]));
}

/** "12345678", "12345678-2-41" or "12345678241" → "12345678". */
export function taxpayerIdOf(taxNumber: string): string {
  const digits = taxNumber.replace(/[\s-]/g, "");
  if (!/^\d{8}(\d{3})?$/.test(digits)) {
    throw new NavConfigError(`not a Hungarian tax number: "${taxNumber}" (expected 12345678 or 12345678-2-41)`);
  }
  return digits.slice(0, 8);
}

export function navEnvironmentOf(env: EnvSource): NavEnvironment {
  const value = (env.NAV_ENVIRONMENT ?? "test").trim();
  if (value !== "test" && value !== "production") {
    throw new NavConfigError(`NAV_ENVIRONMENT must be "test" or "production", got "${value}"`);
  }
  return value;
}

export function credentialsFromEnv(env: EnvSource): NavCredentials {
  const missing = CREDENTIALS.filter((name) => !present(env[name]));
  if (missing.length > 0) {
    throw new NavConfigError(`NAV credentials missing: ${missing.join(", ")}`);
  }
  return {
    login: env.NAV_LOGIN!.trim(),
    password: env.NAV_PASSWORD!,
    signingKey: env.NAV_SIGNING_KEY!.trim(),
    exchangeKey: env.NAV_EXCHANGE_KEY!.trim(),
    taxNumber: taxpayerIdOf(env.NAV_TAX_NUMBER!),
  };
}

/**
 * How the program introduces itself on every request (specification 1.3.3).
 * The id defaults to the taxpayer's eight digits followed by SZAMLAZO-1,
 * which fits NAV's 18-character pattern; the contact must be a real address,
 * because it is where NAV writes about the software.
 */
export function softwareFromEnv(env: EnvSource, defaults: { version?: string } = {}): SoftwareDescription {
  const missing = (["NAV_SOFTWARE_DEV_NAME", "NAV_SOFTWARE_DEV_CONTACT"] as const).filter(
    (name) => !present(env[name]),
  );
  if (missing.length > 0) {
    throw new NavConfigError(`NAV software description missing: ${missing.join(", ")}`);
  }
  const operation = (env.NAV_SOFTWARE_OPERATION ?? "ONLINE_SERVICE").trim();
  if (operation !== "ONLINE_SERVICE" && operation !== "LOCAL_SOFTWARE") {
    throw new NavConfigError(`NAV_SOFTWARE_OPERATION must be ONLINE_SERVICE or LOCAL_SOFTWARE, got "${operation}"`);
  }
  const taxpayerId = present(env.NAV_TAX_NUMBER) ? taxpayerIdOf(env.NAV_TAX_NUMBER) : undefined;
  const softwareId = present(env.NAV_SOFTWARE_ID)
    ? env.NAV_SOFTWARE_ID.trim()
    : taxpayerId
      ? `${taxpayerId}SZAMLAZO-1`
      : undefined;
  if (!softwareId) throw new NavConfigError("NAV_SOFTWARE_ID is not set and there is no NAV_TAX_NUMBER to derive it from");

  return {
    softwareId,
    softwareName: (env.NAV_SOFTWARE_NAME ?? "szamlazo").trim() || "szamlazo",
    softwareOperation: operation,
    softwareMainVersion: (env.NAV_SOFTWARE_VERSION ?? defaults.version ?? "1.0").trim(),
    softwareDevName: env.NAV_SOFTWARE_DEV_NAME!.trim(),
    softwareDevContact: env.NAV_SOFTWARE_DEV_CONTACT!.trim(),
    softwareDevCountryCode: "HU",
    softwareDevTaxNumber: present(env.NAV_SOFTWARE_DEV_TAX_NUMBER)
      ? taxpayerIdOf(env.NAV_SOFTWARE_DEV_TAX_NUMBER)
      : undefined,
  };
}

/** A client configured entirely from the environment. */
export function navClientFromEnv(
  env: EnvSource,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; version?: string } = {},
): NavClient {
  return new NavClient({
    environment: navEnvironmentOf(env),
    credentials: credentialsFromEnv(env),
    software: softwareFromEnv(env, { version: options.version }),
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
}
