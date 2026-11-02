import { afterAll, beforeAll, beforeEach, test } from "vitest";
import assert from "node:assert/strict";
import { unzipSync } from "fflate";
import type { Database } from "../src/db/client.js";
import { hashKey, newApiKey } from "../src/http/auth.js";
import { createApp } from "../src/http/app.js";
import { companyBuyer, emptyTables, freshDatabase, privateBuyer, testServices, twoLines } from "./helpers.js";

/** The HTTP API end to end, through Hono's in-process request, against a real database. */

let db: Database;
let close: () => Promise<void>;
const { key, hash } = newApiKey();
const AUTH = { authorization: `Bearer ${key}`, "content-type": "application/json" };

beforeAll(async () => {
  ({ db, close } = await freshDatabase());
});
afterAll(async () => close?.());
beforeEach(async () => emptyTables(db));

function setup(options: Parameters<typeof testServices>[1] = {}) {
  const made = testServices(db, { ...options, env: { API_KEYS: `webshop:${hash}`, ...options.env } });
  let clock = Date.now();
  const app = createApp(made.services, { clientIp: () => "203.0.113.7", now: () => clock });
  const call = (path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { ...AUTH, ...init.headers } });
  const post = (path: string, body: unknown) => call(path, { method: "POST", body: JSON.stringify(body) });
  return { ...made, app, call, post, tick: (ms: number) => (clock += ms) };
}

const invoiceBody = (overrides: Record<string, unknown> = {}) => ({
  reference: "order-1001",
  buyer: privateBuyer,
  lines: twoLines,
  paymentMethod: "transfer",
  ...overrides,
});

test("health needs no key and says only whether the database answers", async () => {
  const { app } = setup();
  const response = await app.request("/health");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok", database: "ok" });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("every /v1 route refuses a missing or wrong key, and a client that keeps guessing is slowed down", async () => {
  const { app } = setup();
  assert.equal((await app.request("/v1/invoices")).status, 401);
  assert.equal((await app.request("/v1/invoices", { headers: { authorization: "Bearer szk_wrong" } })).status, 401);
  assert.equal((await app.request("/v1/invoices", { headers: { authorization: key } })).status, 401, "no Bearer prefix");
  for (let attempt = 0; attempt < 20; attempt++) await app.request("/v1/status", { headers: { authorization: "Bearer szk_x" } });
  const blocked = await app.request("/v1/status", { headers: { authorization: "Bearer szk_x" } });
  assert.equal(blocked.status, 429);
  assert.equal(((await blocked.json()) as { error: { code: string } }).error.code, "TOO_MANY_ATTEMPTS");
});

test("a key is stored only as its hash, and a key whose hash matches is let in", async () => {
  assert.notEqual(hash, key);
  assert.equal(hashKey(key), hash);
  const { call } = setup();
  assert.equal((await call("/v1/status")).status, 200);
});

test("an invoice is issued, its PDF downloads, and the same reference again returns the same invoice", async () => {
  const { post, call } = setup();
  const first = await post("/v1/invoices", invoiceBody());
  assert.equal(first.status, 201);
  const created = (await first.json()) as { alreadyIssued: boolean; invoice: Record<string, unknown> };
  assert.equal(created.alreadyIssued, false);
  assert.match(String(created.invoice.invoiceNumber), /^SZ\d{4}\/00001$/);
  assert.equal(created.invoice.totalGross, 2 * 2100 + 2499);
  assert.equal(created.invoice.totalNet + "" !== "", true);
  assert.equal((created.invoice.email as { to: string }).to, privateBuyer.email);

  const pdf = await call(String(created.invoice.pdf));
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  assert.equal(new TextDecoder().decode((await pdf.arrayBuffer()).slice(0, 5)), "%PDF-");

  const again = await post("/v1/invoices", invoiceBody());
  assert.equal(again.status, 200);
  const repeated = (await again.json()) as { alreadyIssued: boolean; invoice: { id: string } };
  assert.equal(repeated.alreadyIssued, true);
  assert.equal(repeated.invoice.id, created.invoice.id);
});

test("a reference reused with different content is refused, not silently answered", async () => {
  const { post } = setup();
  assert.equal((await post("/v1/invoices", invoiceBody())).status, 201);
  const changed = await post("/v1/invoices", invoiceBody({ paymentMethod: "cash" }));
  assert.equal(changed.status, 409);
  assert.equal(((await changed.json()) as { error: { code: string } }).error.code, "REFERENCE_CONFLICT");
});

test("bad requests are refused with every problem named, and nothing is issued", async () => {
  const { post, call } = setup();
  const cases: [unknown, string][] = [
    [invoiceBody({ lines: [{ ...twoLines[0], vatRate: 20 }] }), "lines.0.vatRate"],
    [invoiceBody({ lines: [{ ...twoLines[0], quantity: 1.5 }] }), "lines.0.quantity"],
    [invoiceBody({ lines: [{ ...twoLines[0], unitPriceGross: -100 }] }), "lines.0.unitPriceGross"],
    [invoiceBody({ lines: [] }), "lines"],
    [invoiceBody({ buyer: { ...privateBuyer, name: "Evil\u0000Name" } }), "buyer.name"],
    [invoiceBody({ buyer: { ...companyBuyer, taxNumber: undefined } }), "buyer.taxNumber"],
    [invoiceBody({ buyer: { ...privateBuyer, taxNumber: "12345678-2-41" } }), "buyer.taxNumber"],
    [invoiceBody({ buyer: { ...privateBuyer, postcode: "ABCD" } }), "buyer.postcode"],
    [invoiceBody({ fulfilmentDate: "2026-02-30" }), "fulfilmentDate"],
    [invoiceBody({ reference: "spaces are not allowed" }), "reference"],
    [invoiceBody({ isAdmin: true }), ""],
    [invoiceBody({ lines: [{ ...twoLines[0], quantity: 1000, unitPriceGross: 1_000_000_000 }] }), "lines"],
  ];
  for (const [body, path] of cases) {
    const response = await post("/v1/invoices", body);
    assert.equal(response.status, 400, `expected 400 for ${path}`);
    const answer = (await response.json()) as { error: { details: { path: string }[] } };
    assert.ok(answer.error.details.some((detail) => detail.path === path), `expected a problem at "${path}", got ${JSON.stringify(answer.error.details)}`);
  }
  const notJson = await call("/v1/invoices", { method: "POST", body: "{nope" });
  assert.equal(notJson.status, 400);
  const list = (await (await call("/v1/invoices")).json()) as { total: number };
  assert.equal(list.total, 0);
});

test("a body over 256 KB is refused before it is read", async () => {
  const { post } = setup();
  const response = await post("/v1/invoices", invoiceBody({ note: "x".repeat(300 * 1024) }));
  assert.equal(response.status, 413);
});

test("a company NAV does not know is refused; one it knows is invoiced with its full tax number", async () => {
  const { post, nav } = setup();
  const refused = await post("/v1/invoices", invoiceBody({ buyer: companyBuyer }));
  assert.equal(refused.status, 422);
  assert.equal(((await refused.json()) as { error: { code: string } }).error.code, "TAXPAYER_INVALID");

  nav.taxpayers.set("87654321", {
    valid: true,
    taxpayerId: "87654321",
    name: "PÉLDA KFT",
    vatCode: "2",
    countyCode: "43",
    incorporation: "ORGANIZATION",
    addresses: [],
  });
  const wrongDigits = await post("/v1/invoices", invoiceBody({ buyer: { ...companyBuyer, taxNumber: "87654321-1-42" } }));
  assert.equal(wrongDigits.status, 422, "NAV knows the company under other VAT and county digits");

  const issued = await post("/v1/invoices", invoiceBody({ buyer: companyBuyer }));
  assert.equal(issued.status, 201);
  const { invoice } = (await issued.json()) as { invoice: { buyer: { taxNumber: string } } };
  assert.equal(invoice.buyer.taxNumber, "87654321-2-43");
});

test("NAV being unreachable does not stop a company invoice whose full number is given", async () => {
  const { post, nav } = setup();
  nav.down = true;
  assert.equal((await post("/v1/invoices", invoiceBody({ buyer: companyBuyer }))).status, 201);
});

test("a storno reverses an invoice once; a storno cannot itself be reversed", async () => {
  const { post } = setup();
  const created = (await (await post("/v1/invoices", invoiceBody())).json()) as { invoice: { id: string; invoiceNumber: string; totalGross: number } };
  const first = await post(`/v1/invoices/${created.invoice.id}/storno`, { note: "A vevő elállt." });
  assert.equal(first.status, 201);
  const storno = (await first.json()) as { invoice: { id: string; type: string; reverses: string; totalGross: number } };
  assert.equal(storno.invoice.type, "storno");
  assert.equal(storno.invoice.reverses, created.invoice.invoiceNumber);
  assert.equal(storno.invoice.totalGross, -created.invoice.totalGross);

  const again = await post(`/v1/invoices/${created.invoice.id}/storno`, {});
  assert.equal(again.status, 200);
  assert.equal(((await again.json()) as { invoice: { id: string } }).invoice.id, storno.invoice.id);

  const ofStorno = await post(`/v1/invoices/${storno.invoice.id}/storno`, {});
  assert.equal(ofStorno.status, 422);
});

test("unknown ids and malformed ids are a 404, never a database error", async () => {
  const { call, post } = setup();
  assert.equal((await call("/v1/invoices/00000000-0000-0000-0000-000000000000")).status, 404);
  assert.equal((await call("/v1/invoices/../../etc/passwd")).status, 404);
  assert.equal((await call("/v1/invoices/1%27%20or%201=1")).status, 404);
  assert.equal((await post("/v1/invoices/not-a-uuid/storno", {})).status, 404);
});

test("a PDF that no longer matches its fingerprint is not served", async () => {
  const { post, call, store } = setup();
  const { invoice } = (await (await post("/v1/invoices", invoiceBody())).json()) as { invoice: { pdf: string } };
  const [path] = [...store.contents.keys()];
  store.contents.set(path!, new TextEncoder().encode("%PDF- tampered"));
  const response = await call(invoice.pdf);
  assert.equal(response.status, 500);
  assert.equal(((await response.json()) as { error: { code: string } }).error.code, "PDF_CHANGED");
});

test("the list filters by date, number and reference", async () => {
  const { post, call } = setup();
  await post("/v1/invoices", invoiceBody({ reference: "a" }));
  await post("/v1/invoices", invoiceBody({ reference: "b" }));
  const all = (await (await call("/v1/invoices")).json()) as { total: number };
  assert.equal(all.total, 2);
  const one = (await (await call("/v1/invoices?reference=b")).json()) as { total: number; invoices: { reference: string }[] };
  assert.equal(one.total, 1);
  assert.equal(one.invoices[0]!.reference, "b");
  assert.equal((await call("/v1/invoices?limit=1000")).status, 400);
});

test("the inspection export holds one XML per invoice, and is recorded in the audit log", async () => {
  const { post, call } = setup();
  await post("/v1/invoices", invoiceBody({ reference: "a" }));
  await post("/v1/invoices", invoiceBody({ reference: "b" }));
  const today = new Date().toISOString().slice(0, 10);
  const response = await call(`/v1/exports/inspection?from=2000-01-01&to=${today.slice(0, 4)}-12-31`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-invoice-count"), "2");
  const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
  assert.equal(Object.keys(files).length, 2);
  assert.match(new TextDecoder().decode(Object.values(files)[0]!), /<data:InvoiceData/);
  assert.equal((await call("/v1/exports/inspection?from=yesterday")).status, 400);
});

test("status shows what is waiting", async () => {
  const { post, call } = setup();
  await post("/v1/invoices", invoiceBody());
  const status = (await (await call("/v1/status")).json()) as { invoices: { issued: number; awaitingNav: number } };
  assert.equal(status.invoices.issued, 1);
  assert.equal(status.invoices.awaitingNav, 1);
});
