import { afterAll, beforeAll, beforeEach, test } from "vitest";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { parseInvoiceNumber } from "@szamlazo/invoicing";
import type { Database } from "../src/db/client.js";
import { invoices } from "../src/db/schema.js";
import { lastInvoiceNumber } from "../src/db/sequence.js";
import { issue, issueRequestSchema } from "../src/invoices.js";
import { emptyTables, freshDatabase, privateBuyer, testServices, twoLines } from "./helpers.js";

/**
 * The numbering is the one thing an invoicing program cannot repair
 * afterwards, so it is tested with real parallel transactions. A pool of one
 * connection would make these pass by accident, so it has many.
 */
const PARALLEL = 24;
let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await freshDatabase(PARALLEL));
});
afterAll(async () => close?.());
beforeEach(async () => emptyTables(db));

const request = (reference?: string) =>
  issueRequestSchema.parse({ reference, buyer: privateBuyer, lines: twoLines, paymentMethod: "card" });

test("invoices issued at the same moment get consecutive numbers: no gaps, no duplicates", async () => {
  const { services } = testServices(db);
  const issued = await Promise.all(
    Array.from({ length: PARALLEL }, (_, index) =>
      issue(db, services.store, services.settings, request(`order-${index}`), { actor: "test" }),
    ),
  );
  const sequences = issued.map(({ invoice }) => parseInvoiceNumber(invoice.invoiceNumber)!.sequence).sort((a, b) => a - b);
  assert.deepEqual(sequences, Array.from({ length: PARALLEL }, (_, index) => index + 1));
  assert.equal(await lastInvoiceNumber(db), PARALLEL);
});

test("a failure after the number is drawn gives the number back", async () => {
  const { services } = testServices(db);
  const broken = { ...services.store, put: async () => Promise.reject(new Error("disk full")) };
  await assert.rejects(issue(db, broken, services.settings, request(), { actor: "test" }), /disk full/);
  assert.equal(await lastInvoiceNumber(db), 0);

  const { invoice } = await issue(db, services.store, services.settings, request(), { actor: "test" });
  assert.equal(invoice.invoiceNumber, `SZ${new Date().getUTCFullYear()}/00001`);
});

test("the same reference asked for in parallel issues one invoice", async () => {
  const { services } = testServices(db);
  const results = await Promise.all(
    Array.from({ length: 8 }, () => issue(db, services.store, services.settings, request("order-same"), { actor: "test" })),
  );
  assert.equal(new Set(results.map(({ invoice }) => invoice.invoiceNumber)).size, 1);
  assert.equal(results.filter((result) => !result.alreadyIssued).length, 1);
  assert.equal(await lastInvoiceNumber(db), 1);
});

test("an issued invoice cannot be changed or deleted, even by hand", async () => {
  const { services } = testServices(db);
  const { invoice } = await issue(db, services.store, services.settings, request(), { actor: "test" });
  // Drizzle wraps Postgres's error; the trigger's own message is its cause.
  const refused = (error: unknown) => /append-only/.test(String((error as { cause?: Error }).cause?.message));
  await assert.rejects(db.execute(sql`update invoices set total_gross = 1 where id = ${invoice.id}`), refused);
  await assert.rejects(db.execute(sql`delete from invoices where id = ${invoice.id}`), refused);
  await assert.rejects(db.execute(sql`delete from audit_log`), refused);
  const [still] = await db.select().from(invoices);
  assert.equal(still!.totalGross, invoice.totalGross);
});
