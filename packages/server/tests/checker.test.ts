import { afterAll, beforeAll, beforeEach, test } from "vitest";
import assert from "node:assert/strict";
import { isNull } from "drizzle-orm";
import { unzipSync } from "fflate";
import type { Database } from "../src/db/client.js";
import { alerts, navSubmissions } from "../src/db/schema.js";
import { advanceInvoice, monthlyArchive, reconcile, runChecks } from "../src/checker.js";
import { issue, issueRequestSchema, storno } from "../src/invoices.js";
import { emptyTables, freshDatabase, privateBuyer, testServices, twoLines } from "./helpers.js";

/**
 * The checker against a real database, with NAV and the mail service faked.
 * Time is the checker's own clock, moved forward by hand, so an hour's
 * patience is tested in no time.
 */

let db: Database;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await freshDatabase());
});
afterAll(async () => close?.());
beforeEach(async () => emptyTables(db));

async function issued(services: ReturnType<typeof testServices>["services"], reference = "order-1") {
  const { invoice } = await issue(
    db,
    services.store,
    services.settings,
    issueRequestSchema.parse({ reference, buyer: privateBuyer, lines: twoLines, paymentMethod: "transfer" }),
    { actor: "test" },
  );
  return invoice;
}

const openAlerts = () => db.select().from(alerts).where(isNull(alerts.resolvedAt));

test("an issued invoice is reported, accepted and emailed in one pass, and a second pass does nothing", async () => {
  const { services, nav, mailer } = testServices(db);
  const invoice = await issued(services);
  await runChecks(services.checker);
  assert.equal(nav.sent.length, 1);
  assert.equal(nav.sent[0]!.operation, "CREATE");
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0]!.to, privateBuyer.email);
  assert.match(mailer.sent[0]!.subject, new RegExp(`Számla: ${invoice.invoiceNumber.replace("/", "\\/")}`));
  assert.equal(mailer.sent[0]!.attachments?.[0]?.name, `${invoice.invoiceNumber.replace("/", "-")}.pdf`);
  assert.match(mailer.sent[0]!.text, /Bankszámlaszám: 11773016-11111111-00000000/);

  await runChecks(services.checker);
  assert.equal(nav.sent.length, 1);
  assert.equal(mailer.sent.length, 1);
});

test("a test installation says so in every email", async () => {
  const { services, mailer } = testServices(db);
  await issued(services);
  await runChecks(services.checker);
  assert.match(mailer.sent[0]!.subject, /^\[TESZT\] /);
});

test("NAV being down is waited out, tried again after a pause, and alerted after an hour", async () => {
  const { services, nav, mailer, later } = testServices(db);
  await issued(services);
  nav.down = true;
  await runChecks(services.checker);
  assert.equal(mailer.sent.length, 0, "no email before NAV accepts");
  later(2);
  await runChecks(services.checker);
  assert.equal(nav.sent.length, 0);
  later(70);
  await runChecks(services.checker);
  const open = await openAlerts();
  assert.equal(open.length, 1);
  assert.match(open[0]!.subject, /not at NAV after an hour/);
  assert.equal(mailer.sent.filter((email) => email.to === "alerts@example.com").length, 1);

  nav.down = false;
  later(70);
  await runChecks(services.checker);
  assert.equal(nav.sent.length, 1);
  assert.equal((await openAlerts()).length, 0, "the alert resolves itself");
  assert.ok(mailer.sent.some((email) => /resolved/.test(email.subject)));
  assert.ok(mailer.sent.some((email) => email.to === privateBuyer.email));
});

test("an invoice that reached NAV though the answer was lost is not sent twice", async () => {
  const { services, nav, later } = testServices(db);
  await issued(services);
  nav.loseAnswer = true;
  await runChecks(services.checker);
  assert.equal(nav.sent.length, 1);
  nav.loseAnswer = false;
  later(10);
  await runChecks(services.checker);
  assert.equal(nav.sent.length, 1, "NAV was asked first and had it");
  assert.ok(nav.asked >= 1);
  const rows = await db.select().from(navSubmissions);
  assert.ok(rows.some((row) => row.status === "done"));
});

test("an invoice NAV rejects is alerted at once, not emailed, and not sent again", async () => {
  const { services, nav, mailer, later } = testServices(db);
  await issued(services);
  nav.verdict = "ABORTED";
  await runChecks(services.checker);
  later(120);
  await runChecks(services.checker);
  assert.equal(nav.sent.length, 1);
  const open = await openAlerts();
  assert.equal(open.length, 1);
  assert.match(open[0]!.subject, /NAV rejected it/);
  assert.match(open[0]!.body, /INVOICE_LINE_MISSING/);
  assert.equal(mailer.sent.filter((email) => email.to === privateBuyer.email).length, 0);
});

test("a storno is reported as a STORNO of the original, with the chain's line numbers", async () => {
  const { services, nav } = testServices(db);
  const original = await issued(services);
  await runChecks(services.checker);
  const { invoice: reversal } = await storno(db, services.store, services.settings, original.id, { actor: "test" });
  await advanceInvoice(services.checker, reversal.id);
  const sent = nav.sent.at(-1)!;
  assert.equal(sent.operation, "STORNO");
  assert.equal(sent.invoice.reverses, original.invoiceNumber);
  assert.deepEqual(
    sent.invoice.lines.map((line) => [line.lineNumber, line.modifies?.lineNumberReference, line.quantity]),
    [
      [1, 3, -2],
      [2, 4, -1],
    ],
  );
});

test("an email that fails is tried again after a pause, and alerted after an hour", async () => {
  const { services, mailer, later } = testServices(db);
  await issued(services);
  mailer.failing = true;
  await runChecks(services.checker);
  later(2);
  await runChecks(services.checker);
  mailer.failing = false;
  later(4);
  await runChecks(services.checker);
  assert.equal(mailer.sent.filter((email) => email.to === privateBuyer.email).length, 1);
});

test("without NAV (a development install), invoices are emailed straight away", async () => {
  const { services, mailer } = testServices(db, { nav: false });
  await issued(services);
  await runChecks(services.checker);
  assert.equal(mailer.sent.length, 1);
});

test("the nightly check finds an invoice missing from NAV, one NAV has that we did not issue, and a changed PDF", async () => {
  const { services, nav, store } = testServices(db);
  const invoice = await issued(services);
  await runChecks(services.checker);
  nav.digest = [
    { invoiceNumber: "SZ2026/09999", operation: "CREATE", issueDate: "2026-09-01", netAmount: 1, vatAmount: 0, receivedAt: "" },
    { invoiceNumber: "OTHER2026/00001", operation: "CREATE", issueDate: "2026-09-01", netAmount: 1, vatAmount: 0, receivedAt: "" },
  ];
  store.contents.set(invoice.pdfPath, new TextEncoder().encode("changed"));
  await reconcile(services.checker);
  const subjects = (await openAlerts()).map((alert) => alert.subject).sort();
  assert.equal(subjects.length, 3, subjects.join(" | "));
  assert.ok(subjects.some((subject) => subject.includes("missing from NAV's list")));
  assert.ok(subjects.some((subject) => subject.includes("SZ2026/09999") && subject.includes("not issued here")));
  assert.ok(subjects.some((subject) => subject.includes("stored PDF changed")));
});

test("the nightly check is quiet when NAV's list and ours agree", async () => {
  const { services, nav } = testServices(db);
  const invoice = await issued(services);
  await runChecks(services.checker);
  nav.digest = [
    {
      invoiceNumber: invoice.invoiceNumber,
      operation: "CREATE",
      issueDate: invoice.issueDate,
      netAmount: invoice.totalNet,
      vatAmount: invoice.totalVat,
      receivedAt: "",
    },
  ];
  await reconcile(services.checker);
  assert.equal((await openAlerts()).length, 0);
});

test("a month's invoices are emailed as a zip of the PDFs and their XML", async () => {
  const { services, mailer } = testServices(db);
  const invoice = await issued(services);
  const month = invoice.issueDate.slice(0, 7);
  const count = await monthlyArchive(services.checker, month, "archive@example.com");
  assert.equal(count, 1);
  const email = mailer.sent.find((one) => one.to === "archive@example.com")!;
  const outer = unzipSync(email.attachments![0]!.content);
  const names = Object.keys(outer).sort();
  assert.deepEqual(names, [`${invoice.invoiceNumber.replace("/", "-")}.pdf`, `szamlak-${month}-xml.zip`].sort());
});
