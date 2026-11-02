import { afterAll, beforeAll, beforeEach, test } from "vitest";
import assert from "node:assert/strict";
import type { Database } from "../src/db/client.js";
import { newApiKey } from "../src/http/auth.js";
import { createApp } from "../src/http/app.js";
import { runChecks } from "../src/checker.js";
import { companyBuyer, emptyTables, freshDatabase, privateBuyer, testServices } from "./helpers.js";

/** Lines without VAT through the API, the database and the NAV report. */

let db: Database;
let close: () => Promise<void>;
const { key, hash } = newApiKey();
const AUTH = { authorization: `Bearer ${key}`, "content-type": "application/json" };

beforeAll(async () => {
  ({ db, close } = await freshDatabase());
});
afterAll(async () => close?.());
beforeEach(async () => emptyTables(db));

function setup(env: Record<string, string> = {}) {
  const made = testServices(db, { env: { API_KEYS: `webshop:${hash}`, ...env } });
  made.nav.taxpayers.set("87654321", {
    valid: true,
    taxpayerId: "87654321",
    name: "PÉLDA KFT",
    vatCode: "2",
    countyCode: "43",
    incorporation: "ORGANIZATION",
    addresses: [],
  });
  const app = createApp(made.services, { clientIp: () => "203.0.113.7" });
  const post = (body: unknown) => app.request("/v1/invoices", { method: "POST", headers: AUTH, body: JSON.stringify(body) });
  return { ...made, post };
}

type Answer = {
  invoice: { id: string; totalNet: number; totalVat: number; totalGross: number; lines: { vatExemption?: { case: string; reason: string } }[] };
  error: { code: string; message: string };
};

const course = { description: "Tanfolyam", quantity: 1, unit: "db", unitPriceGross: 50_000, vatRate: 0 };
const book = { description: "Jegyzet", quantity: 2, unit: "db", unitPriceGross: 2540, vatRate: 27 };
const body = (lines: unknown[], buyer: unknown = privateBuyer) => ({ buyer, lines, paymentMethod: "card" });

test("a TAM line beside a 27% line is issued, priced, stored and reported with its reason", async () => {
  const { post, services, nav } = setup();
  const response = await post(body([book, { ...course, vatExemption: { case: "TAM", reason: "Áfa tv. 85. § (1) e)" } }]));
  assert.equal(response.status, 201);
  const { invoice } = (await response.json()) as Answer;
  assert.deepEqual([invoice.totalNet, invoice.totalVat, invoice.totalGross], [54_000, 1080, 55_080]);
  assert.deepEqual(invoice.lines[1]!.vatExemption, { case: "TAM", reason: "Áfa tv. 85. § (1) e)" });

  await runChecks(services.checker);
  const reported = nav.sent[0]!.invoice;
  assert.deepEqual(reported.lines[1]!.vatExemption, { case: "TAM", reason: "Áfa tv. 85. § (1) e)" });
  assert.deepEqual(
    reported.vatSummary.map((row) => [row.vatRate, row.vatExemption?.case ?? null, row.net, row.vat]),
    [
      [27, null, 4000, 1080],
      [0, "TAM", 50_000, 0],
    ],
  );
});

test("out of scope and reverse charge get their legal wording when none is given", async () => {
  const { post } = setup();
  const atk = (await (await post(body([{ ...course, vatExemption: { case: "ATK" } }]))).json()) as Answer;
  assert.match(atk.invoice.lines[0]!.vatExemption!.reason, /hatályán kívüli/);

  const reverse = await post(body([{ ...course, vatExemption: { case: "REVERSE_CHARGE" } }], companyBuyer));
  assert.equal(reverse.status, 201);
  const { invoice } = (await reverse.json()) as Answer;
  assert.match(invoice.lines[0]!.vatExemption!.reason, /Fordított adózás/);
  assert.equal(invoice.totalVat, 0);
});

test("VAT that does not add up to a lawful invoice is refused, and no number is used", async () => {
  const { post } = setup();
  const refusals: [unknown[], unknown, RegExp][] = [
    [[course], privateBuyer, /needs vatExemption/],
    [[{ ...book, vatExemption: { case: "TAM", reason: "x" } }], privateBuyer, /must have vatRate 0/],
    [[{ ...course, vatExemption: { case: "TAM" } }], privateBuyer, /legal ground/],
    [[{ ...course, vatExemption: { case: "AAM" } }], privateBuyer, /SELLER_AAM/],
    [[{ ...course, vatExemption: { case: "REVERSE_CHARGE" } }], privateBuyer, /company buyer/],
  ];
  for (const [lines, buyer, message] of refusals) {
    const response = await post(body(lines, buyer));
    assert.equal(response.status, 422, String(message));
    const { error } = (await response.json()) as Answer;
    assert.equal(error.code, "VAT_INVALID");
    assert.match(error.message, message);
  }
  const issued = (await (await post(body([book]))).json()) as { invoice: { invoiceNumber: string } };
  assert.match(issued.invoice.invoiceNumber, /\/00001$/, "the refusals used up no number");

  const unknownCase = await post(body([{ ...course, vatExemption: { case: "KBAET" } }]));
  assert.equal(unknownCase.status, 400);
});

test("an alanyi adómentes seller's lines are AAM without saying so, and cannot carry VAT", async () => {
  const { post } = setup({ SELLER_AAM: "true" });
  const response = await post(body([course, { ...course, description: "Konzultáció" }]));
  assert.equal(response.status, 201);
  const { invoice } = (await response.json()) as Answer;
  assert.deepEqual(invoice.lines.map((line) => line.vatExemption?.case), ["AAM", "AAM"]);
  assert.equal(invoice.totalVat, 0);

  const withVat = await post(body([book]));
  assert.equal(withVat.status, 422);
  assert.match(((await withVat.json()) as Answer).error.message, /alanyi adómentes/);
});
