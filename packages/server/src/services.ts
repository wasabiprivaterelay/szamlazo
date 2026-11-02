import { readFileSync, statSync } from "node:fs";
import type { Logger } from "pino";
import type { Party } from "@szamlazo/invoicing";
import { navClientFromEnv, type NavClient, type Taxpayer } from "@szamlazo/nav";
import type { Database } from "./db/client.js";
import type { CheckerDeps } from "./checker.js";
import { brevoMailer, brevoUndelivered } from "./email.js";
import { ConfigError, type Env } from "./env.js";
import type { IssueSettings } from "./invoices.js";
import { storeFromEnv, type InvoiceStore } from "./storage.js";

/** The server's version, which is also how it introduces itself to NAV. */
export const VERSION = "0.1.0";

/** Everything the routes and the checker need, built once from the environment. */
export type Services = {
  env: Env;
  db: Database;
  store: InvoiceStore;
  settings: IssueSettings;
  nav?: NavClient;
  lookupTaxpayer?: (taxNumber: string) => Promise<Taxpayer>;
  checker: CheckerDeps;
  log: Logger;
};

export function sellerOf(env: Env): Party {
  return {
    name: env.SELLER_NAME,
    postcode: env.SELLER_POSTCODE,
    city: env.SELLER_CITY,
    address: env.SELLER_ADDRESS,
    countryCode: "HU",
    taxNumber: env.SELLER_TAX_NUMBER,
    registrationNumber: env.SELLER_REGISTRATION_NUMBER,
    bankAccount: env.SELLER_BANK_ACCOUNT,
    bankName: env.SELLER_BANK_NAME,
    email: env.SELLER_EMAIL,
    phone: env.SELLER_PHONE,
  };
}

/** A logo for the PDF: PNG or JPEG, at most 1 MB, checked by its first bytes rather than its name. */
export function readLogo(path: string): Uint8Array {
  const size = statSync(path).size;
  if (size > 1024 * 1024) throw new ConfigError(`INVOICE_LOGO_PATH is ${size} bytes; keep the logo under 1 MB`);
  const bytes = new Uint8Array(readFileSync(path));
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!png && !jpeg) throw new ConfigError("INVOICE_LOGO_PATH must be a PNG or JPEG file");
  return bytes;
}

export function settingsOf(env: Env): IssueSettings {
  return {
    seller: sellerOf(env),
    sellerAam: env.SELLER_AAM,
    numberFormat: { prefix: env.INVOICE_PREFIX },
    paymentTermDays: env.PAYMENT_TERM_DAYS,
    pdf: {
      logo: env.INVOICE_LOGO_PATH ? readLogo(env.INVOICE_LOGO_PATH) : undefined,
      accentColour: env.INVOICE_ACCENT_COLOUR,
      footer: env.INVOICE_FOOTER,
    },
  };
}

export function servicesFromEnv(env: Env, db: Database, log: Logger): Services {
  const nav = env.nav.configured ? navClientFromEnv(env.source, { version: VERSION }) : undefined;
  const store = storeFromEnv(env);
  const isTest = env.ENVIRONMENT !== "production";
  const mailer = env.BREVO_API_KEY
    ? brevoMailer({
        apiKey: env.BREVO_API_KEY,
        from: { name: env.EMAIL_FROM_NAME ?? env.SELLER_NAME, email: env.EMAIL_FROM! },
        replyTo: env.EMAIL_REPLY_TO ?? env.SELLER_EMAIL,
        subjectPrefix: isTest ? "[TESZT] " : undefined,
      })
    : undefined;

  return {
    env,
    db,
    store,
    settings: settingsOf(env),
    nav,
    lookupTaxpayer: nav ? (taxNumber) => nav.queryTaxpayer(taxNumber) : undefined,
    log,
    checker: {
      db,
      store,
      nav,
      mailer,
      undelivered: env.BREVO_API_KEY ? brevoUndelivered(env.BREVO_API_KEY) : undefined,
      numberFormat: { prefix: env.INVOICE_PREFIX },
      isTest,
      production: env.ENVIRONMENT === "production",
      alertTo: env.ALERT_EMAIL,
      archiveTo: env.INVOICE_ARCHIVE_EMAIL,
      log,
    },
  };
}
