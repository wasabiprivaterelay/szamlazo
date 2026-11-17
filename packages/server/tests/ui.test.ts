import { afterAll, beforeAll, beforeEach, test } from "vitest";
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../src/db/client.js";
import { createApp } from "../src/http/app.js";
import { accessVerifier } from "../src/http/access.js";
import { brevoMailer } from "../src/email.js";
import { invoiceEmail } from "../src/messages.js";
import { advanceInvoice, sendInvoiceEmail } from "../src/checker.js";
import { companyBuyer, emptyTables, freshDatabase, privateBuyer, testEnv, testServices, twoLines } from "./helpers.js";

/**
 * The web page and what it relies on: the Access login check, the preview
 * that issues nothing, the buyer list, and the HTML email.
 */

let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await freshDatabase());
});
afterAll(async () => close?.());
beforeEach(async () => emptyTables(db));

const TEAM = "minta.cloudflareaccess.com";
const AUD = "a".repeat(64);
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const accessFetch = (async () => {
  return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } });
}) as unknown as typeof fetch;

function token(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "k1" }): string {
  const now = Math.floor(Date.now() / 1000);
  const body = { iss: `https://${TEAM}`, aud: [AUD], email: "anna@minta.hu", iat: now, nbf: now, exp: now + 3600, ...claims };
  const encode = (part: unknown) => Buffer.from(JSON.stringify(part)).toString("base64url");
  const signed = `${encode(header)}.${encode(body)}`;
  const signature = createSign("RSA-SHA256").update(signed).sign(privateKey).toString("base64url");
  return `${signed}.${signature}`;
}

const UI_ENV = { UI_USERS: "anna@minta.hu, bela@minta.hu", ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };

function setup(env: Record<string, string | undefined> = UI_ENV) {
  const made = testServices(db, { env });
  const app = createApp(made.services, { clientIp: () => "203.0.113.9", accessFetch });
  const as = (jwt: string | undefined, init: RequestInit = {}) => ({
    ...init,
    headers: { ...(jwt ? { "cf-access-jwt-assertion": jwt } : {}), "content-type": "application/json", ...init.headers },
  });
  return { ...made, app, as };
}

test("the login check takes only a fresh token signed by the team, for this application, naming a listed person", async () => {
  const verify = accessVerifier({ teamDomain: TEAM, audience: AUD, users: ["Anna@Minta.hu"], fetchImpl: accessFetch });
  const good = await verify(token({ country: "HU" }));
  assert.equal(good?.email, "anna@minta.hu");
  assert.equal(good?.allowed, true);
  assert.equal(good?.country, "HU");
  assert.equal((await verify(token({ email: "someone@else.hu" })))?.allowed, false, "a valid login, but not on UI_USERS");
  assert.equal(await verify(token({ aud: ["b".repeat(64)] })), undefined, "another application");
  assert.equal(await verify(token({ iss: "https://other.cloudflareaccess.com" })), undefined, "another team");
  assert.equal(await verify(token({ exp: Math.floor(Date.now() / 1000) - 120 })), undefined, "expired");
  assert.equal(await verify(token({ email: undefined, common_name: "service-token" })), undefined, "a service token is not a person");
  assert.equal(await verify(token({}, { alg: "none", kid: "k1" })), undefined, "unsigned");
  assert.equal(await verify(token({}, { alg: "RS256", kid: "unknown" })), undefined, "unknown key");
  const valid = token({});
  const forged = valid.slice(0, valid.lastIndexOf(".")) + "." + Buffer.from("x".repeat(256)).toString("base64url");
  assert.equal(await verify(forged), undefined, "bad signature");
  const [head, , sig] = valid.split(".");
  const swapped = Buffer.from(JSON.stringify({ iss: `https://${TEAM}`, aud: [AUD], email: "bela@minta.hu", exp: 9e9 })).toString("base64url");
  assert.equal(await verify(`${head}.${swapped}.${sig}`), undefined, "claims changed after signing");
  assert.equal(await verify("not.a.token"), undefined);
  assert.equal(await verify(undefined), undefined);
});

test("the page is served only to a logged-in person, with a script nonce and a strict policy", async () => {
  const { app, as } = setup();
  assert.equal((await app.request("/", as(undefined))).status, 403);
  assert.equal((await app.request("/", as(token({ email: "someone@else.hu" })))).status, 403);

  const page = await app.request("/", as(token({})));
  assert.equal(page.status, 200);
  const csp = page.headers.get("content-security-policy") ?? "";
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
  assert.ok(nonce, "the policy names a nonce");
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  const html = await page.text();
  assert.ok(html.includes(`<script nonce="${nonce}">`));
  assert.ok(!html.includes("__NONCE__"));
  const again = await app.request("/", as(token({})));
  assert.notEqual(/nonce-([^']+)/.exec(again.headers.get("content-security-policy") ?? "")?.[1], nonce, "a fresh nonce each time");
});

test("a logged-in person uses the API; a change needs the page's own header; without a login nothing is let in", async () => {
  const { app, as } = setup();
  const jwt = token({});
  const me = await app.request("/v1/me", as(jwt));
  assert.equal(me.status, 200);
  assert.equal(((await me.json()) as { actor: string }).actor, "ui:anna@minta.hu");

  const body = JSON.stringify({ reference: "ui-1", buyer: privateBuyer, lines: twoLines, paymentMethod: "transfer" });
  const noHeader = await app.request("/v1/invoices", as(jwt, { method: "POST", body }));
  assert.equal(noHeader.status, 403, "a form or script on another site cannot add the header");

  const issued = await app.request("/v1/invoices", as(jwt, { method: "POST", body, headers: { "x-szamlazo-ui": "1" } }));
  assert.equal(issued.status, 201);
  const [row] = await db.execute<{ created_by: string }>(sql`select created_by from invoices`);
  assert.equal(row?.created_by, "ui:anna@minta.hu", "the invoice records who issued it");

  assert.equal((await app.request("/v1/invoices", as(undefined))).status, 401);
  assert.equal((await app.request("/v1/invoices", as(token({ aud: ["c".repeat(64)] })))).status, 401);
});

test("without UI_USERS, an Access token is worth nothing and the page is not served", async () => {
  const { app, as } = setup({});
  assert.equal((await app.request("/", as(token({})))).status, 403);
  assert.equal((await app.request("/v1/me", as(token({})))).status, 401);
});

test("the settings refuse a page without the login check, and the development login outside development", () => {
  assert.throws(() => testEnv({ UI_USERS: "anna@minta.hu" }), /UI_USERS needs ACCESS_TEAM_DOMAIN and ACCESS_AUD/);
  assert.throws(() => testEnv({ ...UI_ENV, ACCESS_AUD: "short" }), /ACCESS_AUD/);
  assert.throws(() => testEnv({ UI_DEV_USER: "a@b.hu", ENVIRONMENT: "staging" }), /UI_DEV_USER is only for ENVIRONMENT=development/);
  assert.equal(testEnv({ UI_DEV_USER: "a@b.hu" }).UI_DEV_USER, "a@b.hu");
});

test("a preview is the PDF the request would make, refused for the same reasons, and draws no number", async () => {
  const { app, as } = setup();
  const headers = { "x-szamlazo-ui": "1" };
  const jwt = token({});
  const body = { buyer: privateBuyer, lines: twoLines, paymentMethod: "transfer" };
  const pdf = await app.request("/v1/invoices/preview", as(jwt, { method: "POST", headers, body: JSON.stringify(body) }));
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  assert.equal(new TextDecoder().decode((await pdf.arrayBuffer()).slice(0, 5)), "%PDF-");

  const badVat = { ...body, lines: [{ ...twoLines[0], vatRate: 0 }] };
  const refused = await app.request("/v1/invoices/preview", as(jwt, { method: "POST", headers, body: JSON.stringify(badVat) }));
  assert.equal(refused.status, 422);
  const invalid = await app.request("/v1/invoices/preview", as(jwt, { method: "POST", headers, body: JSON.stringify({ ...body, lines: [] }) }));
  assert.equal(invalid.status, 400);

  const [counted] = await db.execute<{ n: number }>(sql`select count(*)::int as n from invoices`);
  assert.equal(counted?.n, 0);
  const [sequence] = await db.execute<{ last_number: number }>(sql`select last_number from invoice_sequence`);
  assert.equal(Number(sequence?.last_number ?? 0), 0, "no number was used");

  const issued = await app.request("/v1/invoices", as(jwt, { method: "POST", headers, body: JSON.stringify(body) }));
  assert.match(String(((await issued.json()) as { invoice: { invoiceNumber: string } }).invoice.invoiceNumber), /\/00001$/);
});

test("the buyer list has everyone invoiced before, once each, with their latest details", async () => {
  const { app, as, nav: state } = setup();
  state.taxpayers.set("87654321", { valid: true, taxpayerId: "87654321", name: "Példa Kft.", vatCode: "2", countyCode: "43", incorporation: "ORGANIZATION", addresses: [] } as never);
  const headers = { "x-szamlazo-ui": "1" };
  const jwt = token({});
  const issue = (buyer: unknown, reference: string) =>
    app.request("/v1/invoices", as(jwt, { method: "POST", headers, body: JSON.stringify({ reference, buyer, lines: twoLines, paymentMethod: "transfer" }) }));
  assert.equal((await issue(companyBuyer, "a")).status, 201);
  assert.equal((await issue({ ...companyBuyer, address: "Új cím 1." }, "b")).status, 201);
  assert.equal((await issue(privateBuyer, "c")).status, 201);

  const { buyers } = (await (await app.request("/v1/buyers", as(jwt))).json()) as { buyers: { name: string; address: string; type: string }[] };
  assert.equal(buyers.length, 2);
  const company = buyers.find((b) => b.type === "company");
  assert.equal(company?.address, "Új cím 1.", "the newest details");

  const found = (await (await app.request("/v1/invoices?q=" + encodeURIComponent("ödön"), as(jwt))).json()) as { total: number };
  assert.equal(found.total, 1, "search matches a buyer's name, whatever the case");
  const literal = (await (await app.request("/v1/invoices?q=" + encodeURIComponent("%"), as(jwt))).json()) as { total: number };
  assert.equal(literal.total, 0, "a % in the search is a character, not a wildcard");
});

test("the invoice email has an HTML part beside the text, with every value escaped", async () => {
  const seller = { name: "Minta Kft.", postcode: "1011", city: "Budapest", address: "Fő utca 1.", countryCode: "HU", taxNumber: "12345678-2-41", bankAccount: "11773016-11111111-00000000" };
  const email = invoiceEmail(
    {
      invoiceNumber: "SZ2026/00001",
      type: "normal",
      totalGross: 60000,
      currency: "HUF",
      paymentMethod: "transfer",
      dueDate: "2026-11-25",
      buyer: { name: '<img src=x onerror="alert(1)"> & Társa', postcode: "1011", city: "Budapest", address: "x", countryCode: "HU" },
      seller,
    },
    false,
    { accent: '#123456"><script>' },
  );
  assert.match(email.text, /Kedves <img src=x/, "the text part is plain text, as before");
  assert.ok(!email.html.includes("<img"), "markup in a name is shown, never run");
  assert.ok(email.html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; Társa"));
  assert.ok(!email.html.includes("<script>"), "a malformed colour falls back to the default");
  assert.match(email.html, /11773016-11111111-00000000/);
  assert.match(email.html, /2026\.11\.25\./);

  let sent: Record<string, unknown> = {};
  const mailer = brevoMailer({
    apiKey: "k",
    from: { name: "Minta Kft.", email: "szamla@minta.hu" },
    fetchImpl: (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ messageId: "<m1>" }), { status: 201 });
    }) as unknown as typeof fetch,
  });
  await mailer({ to: "a@b.hu", subject: email.subject, text: email.text, html: email.html });
  assert.equal(sent.htmlContent, email.html);
  assert.equal(sent.textContent, email.text);
});

type Entry = { at: string; actor: string; action: string; entity: string; entityId: string; details: Record<string, unknown>; invoiceNumber?: string };

test("the activity log records each login once, with where it came from, and a refused login too", async () => {
  const { app, as } = setup();
  const login = token({ country: "HU" });
  const browser = { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Firefox/140.0", "cf-ipcountry": "HU" };
  await app.request("/", as(login, { headers: browser }));
  await app.request("/v1/me", as(login, { headers: browser }));
  await app.request("/v1/invoices", as(login, { headers: browser }));
  await app.request("/", as(token({ email: "someone@else.hu" })));

  const rows = await db.execute<{ action: string; actor: string; details: Record<string, string> }>(
    sql`select action, actor, details from audit_log where entity = 'session' order by created_at`,
  );
  assert.deepEqual(rows.map((row) => [row.action, row.actor]), [
    ["login", "ui:anna@minta.hu"],
    ["login refused", "ui:someone@else.hu"],
  ], "one entry per login, however many requests it makes");
  assert.equal(rows[0]?.details.ip, "203.0.113.9");
  assert.equal(rows[0]?.details.country, "HU");
  assert.match(String(rows[0]?.details.userAgent), /Firefox/);
  assert.ok(rows[0]?.details.expiresAt);
});

test("every action through the page is logged with who, how and from where; nothing in the log can be changed", async () => {
  const { app, as } = setup();
  const jwt = token({});
  const write = { "x-szamlazo-ui": "1" };
  const body = { reference: "ui-7", buyer: privateBuyer, lines: twoLines, paymentMethod: "transfer", sendEmail: false };
  await app.request("/v1/invoices/preview", as(jwt, { method: "POST", headers: write, body: JSON.stringify(body) }));
  const issued = (await (await app.request("/v1/invoices", as(jwt, { method: "POST", headers: write, body: JSON.stringify(body) }))).json()) as {
    invoice: { id: string; invoiceNumber: string };
  };
  const id = issued.invoice.id;
  await app.request(`/v1/invoices/${id}/pdf`, as(jwt));
  await app.request("/v1/invoices", as(jwt, { method: "POST", headers: write, body: JSON.stringify({ ...body, reference: "ui-8", lines: [{ ...twoLines[0], vatRate: 0 }] }) }));

  const manual = await app.request(`/v1/invoices/${id}/sent-manually`, as(jwt, {
    method: "POST", headers: write, body: JSON.stringify({ to: "vevo@example.com", note: "Gmailből" }),
  }));
  assert.equal(manual.status, 200);
  const viewed = (await manual.json()) as { invoice: { manualEmail: { to: string; by: string } } };
  assert.equal(viewed.invoice.manualEmail.to, "vevo@example.com");
  assert.equal(viewed.invoice.manualEmail.by, "ui:anna@minta.hu");
  assert.equal((await app.request(`/v1/invoices/${id}/sent-manually`, as(jwt, { method: "POST", headers: write, body: "{}" }))).status, 400);

  const history = (await (await app.request(`/v1/invoices/${id}/history`, as(jwt))).json()) as { entries: Entry[] };
  assert.deepEqual(history.entries.map((e) => e.action), ["invoice issued", "email sent manually"]);
  const issuedEntry = history.entries[0]!;
  assert.equal(issuedEntry.actor, "ui:anna@minta.hu");
  assert.equal(issuedEntry.details.via, "web");
  assert.equal(issuedEntry.details.ip, "203.0.113.9");
  assert.equal(issuedEntry.details.buyer, privateBuyer.name);
  assert.equal(issuedEntry.details.invoiceNumber, issued.invoice.invoiceNumber);

  const log = (await (await app.request("/v1/audit", as(jwt))).json()) as { total: number; entries: Entry[]; actors: string[]; actions: string[] };
  const actions = log.entries.map((e) => e.action);
  assert.ok(!actions.includes("invoice previewed") && !actions.includes("pdf downloaded"), "looking is not logged, only doing");
  for (const expected of ["login", "invoice issued", "issue refused", "email sent manually"]) {
    assert.ok(actions.includes(expected), `${expected} is in the log`);
  }
  assert.equal(log.entries.find((e) => e.action === "invoice issued")?.invoiceNumber, issued.invoice.invoiceNumber, "linked to its invoice");
  assert.equal(log.entries.find((e) => e.action === "issue refused")?.details.code, "VAT_INVALID");
  assert.ok(log.actors.includes("ui:anna@minta.hu"));

  const onlyIssued = (await (await app.request("/v1/audit?action=" + encodeURIComponent("invoice issued"), as(jwt))).json()) as { total: number };
  assert.equal(onlyIssued.total, 1);
  const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  const later = (await (await app.request(`/v1/audit?from=${tomorrow}`, as(jwt))).json()) as { total: number };
  assert.equal(later.total, 0, "a date filter excludes what came before");

  const appendOnly = (error: unknown) => /append-only/.test(String((error as { cause?: { message?: string } }).cause?.message ?? error));
  await assert.rejects(db.execute(sql`update audit_log set actor = 'someone else'`), appendOnly);
  await assert.rejects(db.execute(sql`delete from audit_log`), appendOnly);
});

test("what the server does on its own is logged as the system: NAV's answers and the emails", async () => {
  const { app, as, services, mailer, later } = setup();
  const jwt = token({});
  const body = { buyer: privateBuyer, lines: twoLines, paymentMethod: "transfer" };
  const issued = (await (await app.request("/v1/invoices", as(jwt, { method: "POST", headers: { "x-szamlazo-ui": "1" }, body: JSON.stringify(body) }))).json()) as {
    invoice: { id: string };
  };
  await advanceInvoice(services.checker, issued.invoice.id);
  assert.equal(mailer.sent.length, 1);
  later(10);
  await sendInvoiceEmail(services.checker, issued.invoice.id, { copy: "1", to: "masik@example.com" });

  const history = (await (await app.request(`/v1/invoices/${issued.invoice.id}/history`, as(jwt))).json()) as { entries: Entry[] };
  const system = history.entries.filter((e) => e.actor === "system");
  assert.deepEqual(system.map((e) => e.action), ["nav sent", "nav accepted", "email sent", "email sent"]);
  assert.ok(system[0]?.details.transactionId);
  assert.equal(system[2]?.details.to, privateBuyer.email);
  assert.equal(system[3]?.details.copy, true);

  const viewed = (await (await app.request(`/v1/invoices/${issued.invoice.id}`, as(jwt))).json()) as {
    invoice: { lastEmailSent: { to: string; at: string } };
  };
  assert.equal(viewed.invoice.lastEmailSent.to, "masik@example.com", "the status shows the latest send, resends included");
});
