import { z } from "zod";
import { hasNavCredentials, navEnvironmentOf, type EnvSource } from "@szamlazo/nav";

/**
 * Every setting the server reads, in one place, checked at start-up so a
 * mistake is reported by name before anything runs. .env.example lists the
 * same variables with a sentence each on where the value comes from.
 */

/** Present but empty — `FOO=` in an env file — counts as absent. */
const blankIsAbsent = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);
const optionalText = z.preprocess(blankIsAbsent, z.string().trim().optional());
const optionalEmail = z.preprocess(blankIsAbsent, z.email().optional());
const flag = (fallback: boolean) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() !== "" ? value.trim().toLowerCase() : undefined),
    z.enum(["true", "false", "1", "0", "yes", "no"]).optional().transform((value) =>
      value === undefined ? fallback : ["true", "1", "yes"].includes(value),
    ),
  );

/** "12345678-2-41" or "12345678241": a full Hungarian tax number, as an invoice must show it. */
const fullTaxNumber = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s-]/g, ""))
  .refine((digits) => /^\d{11}$/.test(digits), "must be a full 11-digit tax number, e.g. 12345678-2-41")
  .transform((digits) => `${digits.slice(0, 8)}-${digits.slice(8, 9)}-${digits.slice(9)}`);

const schema = z.object({
  DATABASE_URL: z.string().trim().url(),
  /** Which installation this is. Production must report to NAV's live system, and nothing else may. */
  ENVIRONMENT: z.preprocess(blankIsAbsent, z.enum(["development", "staging", "production"]).default("development")),
  HOST: z.preprocess(blankIsAbsent, z.string().trim().default("127.0.0.1")),
  PORT: z.preprocess(blankIsAbsent, z.coerce.number().int().min(1).max(65535).default(3000)),
  LOG_LEVEL: z.preprocess(blankIsAbsent, z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info")),

  /**
   * Who may use the API: comma-separated name:sha256 pairs, made with
   * `npm run szamlazo -- api-key new <name>`. Only hashes are stored here.
   */
  API_KEYS: z.preprocess(
    (value) =>
      typeof value === "string"
        ? value
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean)
        : [],
    z.array(
      z
        .string()
        .regex(/^[a-z0-9][a-z0-9_-]{0,39}:[0-9a-f]{64}$/, "each API_KEYS entry must be name:sha256, as `api-key new` prints it")
        .transform((entry) => {
          const [name, hash] = entry.split(":") as [string, string];
          return { name, hash };
        }),
    ),
  ),
  /**
   * The header holding the client's real address when a proxy stands in
   * front (cf-connecting-ip behind Cloudflare). Unset: the socket address.
   * Set it only when the proxy is the only way in, or anyone can forge it.
   */
  CLIENT_IP_HEADER: optionalText,

  /** The seller, exactly as every invoice will show them. */
  SELLER_NAME: z.string().trim().min(1, "SELLER_NAME is required: the seller's legal name"),
  SELLER_POSTCODE: z.string().trim().regex(/^\d{4}$/, "SELLER_POSTCODE must be a four-digit Hungarian postcode"),
  SELLER_CITY: z.string().trim().min(1, "SELLER_CITY is required"),
  SELLER_ADDRESS: z.string().trim().min(1, "SELLER_ADDRESS is required: street and number, e.g. Fő utca 1."),
  SELLER_TAX_NUMBER: fullTaxNumber,
  /** Cégjegyzékszám for a company, nyilvántartási szám for a sole trader. */
  SELLER_REGISTRATION_NUMBER: optionalText,
  SELLER_BANK_ACCOUNT: optionalText,
  SELLER_BANK_NAME: optionalText,
  SELLER_EMAIL: optionalEmail,
  SELLER_PHONE: optionalText,
  /** Alanyi adómentes (AAM): the seller charges no VAT on anything. */
  SELLER_AAM: flag(false),

  /** The letters in front of every invoice number: SZ gives SZ2026/00001. */
  INVOICE_PREFIX: z.preprocess(
    blankIsAbsent,
    z.string().trim().regex(/^[A-Z]{1,8}$/, "INVOICE_PREFIX must be one to eight capital letters").default("SZ"),
  ),
  /** Days a transfer has to be paid in, when the request names no due date. */
  PAYMENT_TERM_DAYS: z.preprocess(blankIsAbsent, z.coerce.number().int().min(0).max(365).default(8)),
  INVOICE_LOGO_PATH: optionalText,
  INVOICE_ACCENT_COLOUR: z.preprocess(
    blankIsAbsent,
    z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, "INVOICE_ACCENT_COLOUR must look like #1d4f86").default("#1d4f86"),
  ),
  INVOICE_FOOTER: optionalText,

  /** Where PDFs are kept: a folder, or an S3-compatible bucket such as Cloudflare R2. */
  STORAGE: z.preprocess(blankIsAbsent, z.enum(["local", "s3"]).default("local")),
  STORAGE_DIR: z.preprocess(blankIsAbsent, z.string().trim().default("./data/invoices")),
  S3_ENDPOINT: z.preprocess(blankIsAbsent, z.url().optional()),
  S3_BUCKET: optionalText,
  S3_ACCESS_KEY_ID: optionalText,
  S3_SECRET_ACCESS_KEY: optionalText,
  S3_REGION: z.preprocess(blankIsAbsent, z.string().trim().default("auto")),

  /** Email, through Brevo. Without it nothing is sent, and the server says so in /v1/status. */
  BREVO_API_KEY: optionalText,
  EMAIL_FROM: optionalEmail,
  EMAIL_FROM_NAME: optionalText,
  EMAIL_REPLY_TO: optionalEmail,
  /** Who hears about problems: NAV refusing an invoice, an email that will not go. */
  ALERT_EMAIL: optionalEmail,
  /** Where each month's invoices are emailed as a second copy. */
  INVOICE_ARCHIVE_EMAIL: optionalEmail,

  /** Healthchecks.io (or any URL) pinged after every checker pass; /fail when a pass fails. */
  HEALTHCHECK_URL: z.preprocess(blankIsAbsent, z.url().optional()),
  CHECKER_ENABLED: flag(true),
  CHECKER_INTERVAL_SECONDS: z.preprocess(blankIsAbsent, z.coerce.number().int().min(30).max(3600).default(300)),
});

export type Env = z.infer<typeof schema> & {
  /** The raw source, for the NAV settings the nav package reads itself. */
  source: EnvSource;
  nav: { configured: boolean; environment: "test" | "production" };
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Fails at start-up, naming every bad variable, rather than on first use. */
export function readEnv(source: EnvSource = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const name = issue.path.join(".") || "(env)";
      const missing = issue.code === "invalid_type" && source[name] === undefined;
      return `  ${name}: ${missing ? "not set" : issue.message}`;
    });
    throw new ConfigError(`the configuration has problems:\n${problems.join("\n")}`);
  }
  const env = parsed.data;
  let navEnvironment: "test" | "production";
  try {
    navEnvironment = navEnvironmentOf(source);
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : String(error));
  }
  const navConfigured = hasNavCredentials(source);
  const problems: string[] = [];

  // Real invoices reported to the test system are invoices never reported,
  // and test invoices reported to the live system are real ones.
  if (env.ENVIRONMENT === "production") {
    if (!navConfigured) problems.push("production needs the NAV technical user: NAV_LOGIN, NAV_PASSWORD, NAV_SIGNING_KEY, NAV_EXCHANGE_KEY, NAV_TAX_NUMBER");
    if (navEnvironment !== "production") problems.push("production must report to NAV's live system: set NAV_ENVIRONMENT=production");
    if (env.API_KEYS.length === 0) problems.push("production needs at least one API key in API_KEYS");
  } else if (navConfigured && navEnvironment === "production") {
    problems.push(`only ENVIRONMENT=production may report to NAV's live system (this is ${env.ENVIRONMENT})`);
  }
  if (navConfigured) {
    const navTaxpayer = (source.NAV_TAX_NUMBER ?? "").replace(/[\s-]/g, "").slice(0, 8);
    if (navTaxpayer !== env.SELLER_TAX_NUMBER.slice(0, 8)) {
      problems.push("NAV_TAX_NUMBER and SELLER_TAX_NUMBER belong to different taxpayers");
    }
  }
  if (env.STORAGE === "s3") {
    const missing = (["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const).filter((name) => !env[name]);
    if (missing.length > 0) problems.push(`STORAGE=s3 needs ${missing.join(", ")}`);
  }
  if (env.BREVO_API_KEY && !env.EMAIL_FROM) problems.push("BREVO_API_KEY is set but EMAIL_FROM is not");
  const names = env.API_KEYS.map((key) => key.name);
  if (new Set(names).size !== names.length) problems.push("API_KEYS has two keys with the same name");

  if (problems.length > 0) {
    throw new ConfigError(`the configuration has problems:\n${problems.map((problem) => `  ${problem}`).join("\n")}`);
  }
  return { ...env, source, nav: { configured: navConfigured, environment: navEnvironment } };
}
