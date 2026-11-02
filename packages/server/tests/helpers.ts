import { sql } from "drizzle-orm";
import type { InvoiceDigest, NavClient, NavInvoice, Taxpayer } from "@szamlazo/nav";
import { createDatabase, type Database } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { memoryMailer } from "../src/email.js";
import { readEnv, type Env } from "../src/env.js";
import { createLogger } from "../src/logger.js";
import type { Services } from "../src/services.js";
import { settingsOf } from "../src/services.js";
import { memoryStore } from "../src/storage.js";

/**
 * The tests run against a real Postgres: the numbering, the locks and the
 * append-only triggers are the database's work, and a fake would prove
 * nothing about them. NAV and the mail service are fakes that can be told
 * to fail.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgres://szamlazo:szamlazo@127.0.0.1:5432/szamlazo_test";

/** An empty database with the schema applied. */
export async function freshDatabase(max = 10): Promise<{ db: Database; close: () => Promise<void> }> {
  const admin = createDatabase(TEST_DATABASE_URL, { max: 1 });
  await admin.db.execute(sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`);
  await admin.close();
  await migrate(TEST_DATABASE_URL);
  return createDatabase(TEST_DATABASE_URL, { max });
}

/** TRUNCATE is not stopped by the append-only triggers: how a test database is emptied, never a real one. */
export async function emptyTables(db: Database): Promise<void> {
  await db.execute(sql`truncate invoices, nav_submissions, email_log, alerts, job_runs, audit_log cascade`);
  await db.execute(sql`update invoice_sequence set last_number = 0`);
}

export const BASE_ENV = {
  DATABASE_URL: TEST_DATABASE_URL,
  SELLER_NAME: "Minta Bt.",
  SELLER_POSTCODE: "1011",
  SELLER_CITY: "Budapest",
  SELLER_ADDRESS: "Fő utca 1.",
  SELLER_TAX_NUMBER: "12345678-2-41",
  SELLER_BANK_ACCOUNT: "11773016-11111111-00000000",
  SELLER_EMAIL: "info@example.com",
  INVOICE_PREFIX: "SZ",
} satisfies Record<string, string>;

export const quiet = { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {}, child() { return quiet; }, level: "silent" };

export function testEnv(overrides: Record<string, string | undefined> = {}): Env {
  return readEnv({ ...BASE_ENV, ...overrides });
}

/** NAV, as far as the server talks to it. */
export function fakeNav() {
  const state = {
    down: false,
    /** NAV takes the invoice but the answer never reaches us. */
    loseAnswer: false,
    verdict: "DONE" as "DONE" | "ABORTED",
    held: new Map<string, string>(),
    sent: [] as { operation: string; invoice: NavInvoice }[],
    asked: 0,
    digest: [] as InvoiceDigest[],
    taxpayers: new Map<string, Taxpayer>(),
  };
  let transactions = 0;
  const nav = {
    async tokenExchange() {
      return { token: "t", validFrom: "", validTo: "" };
    },
    async manageInvoice(entries: { operation: string; invoice: NavInvoice }[]) {
      if (state.down) throw new Error("fetch failed");
      state.sent.push(entries[0]!);
      const id = `T${++transactions}`;
      state.held.set(entries[0]!.invoice.invoiceNumber, id);
      if (state.loseAnswer) throw new Error("The operation was aborted due to timeout");
      return { transactionId: id };
    },
    async queryTransactionStatus() {
      if (state.down) throw new Error("fetch failed");
      return {
        finished: true,
        invoices: [
          {
            index: 1,
            status: state.verdict,
            messages: state.verdict === "ABORTED" ? ["ERROR INVOICE_LINE_MISSING: a számla sorai hiányoznak"] : [],
          },
        ],
      };
    },
    async queryInvoiceData(invoiceNumber: string) {
      state.asked++;
      if (state.down) throw new Error("fetch failed");
      const transactionId = state.held.get(invoiceNumber);
      return transactionId ? { xml: "", receivedAt: "", technicalUser: "", source: "OSZ", transactionId, requestVersion: "3.0" } : null;
    },
    async queryInvoiceDigest() {
      return state.digest;
    },
    async queryTaxpayer(taxNumber: string): Promise<Taxpayer> {
      if (state.down) throw new Error("fetch failed");
      const id = taxNumber.replace(/\D/g, "").slice(0, 8);
      return state.taxpayers.get(id) ?? { valid: false, taxpayerId: id };
    },
  };
  return { nav: nav as unknown as NavClient, state };
}

/** Services for one test: a real database, everything outside it faked. */
export function testServices(db: Database, options: { env?: Record<string, string | undefined>; nav?: boolean } = {}) {
  const env = testEnv(options.env);
  const { nav, state } = fakeNav();
  const withNav = options.nav ?? true;
  const store = memoryStore();
  const mailer = memoryMailer();
  const clock = { now: new Date() };
  const log = createLogger("silent");
  const services: Services = {
    env,
    db,
    store,
    settings: settingsOf(env),
    nav: withNav ? nav : undefined,
    lookupTaxpayer: withNav ? (taxNumber) => nav.queryTaxpayer(taxNumber) : undefined,
    log,
    checker: {
      db,
      store,
      nav: withNav ? nav : undefined,
      mailer,
      numberFormat: { prefix: env.INVOICE_PREFIX },
      isTest: env.ENVIRONMENT !== "production",
      production: env.ENVIRONMENT === "production",
      alertTo: "alerts@example.com",
      archiveTo: "archive@example.com",
      log,
      now: () => clock.now,
      navPollIntervalMs: 1,
    },
  };
  const later = (minutes: number) => {
    clock.now = new Date(clock.now.getTime() + minutes * 60_000);
  };
  return { services, nav: state, store, mailer, clock, later };
}

export const privateBuyer = {
  type: "private" as const,
  name: "Tűzkő Ödönné",
  postcode: "9021",
  city: "Győr",
  address: "Őrhegyi utca 7.",
  email: "vevo@example.com",
};

export const companyBuyer = {
  type: "company" as const,
  name: "Példa Kft.",
  postcode: "1117",
  city: "Budapest",
  address: "Október huszonharmadika utca 8.",
  taxNumber: "87654321-2-43",
  email: "penzugy@example.com",
};

export const twoLines = [
  { description: "Gyapjú sál", quantity: 2, unit: "db", unitPriceGross: 2100, vatRate: 27 as const },
  { description: "Szállítási díj", quantity: 1, unit: "db", unitPriceGross: 2499, vatRate: 27 as const },
];
