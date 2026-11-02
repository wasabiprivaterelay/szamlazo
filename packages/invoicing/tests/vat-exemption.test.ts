import { test } from "vitest";
import assert from "node:assert/strict";
import { issueInvoice, stornoInvoice } from "../src/invoice.js";
import { inMemorySequence } from "../src/numbering.js";
import { renderInvoicePdf } from "../src/pdf.js";
import type { IssueInput, LineInput, Party } from "../src/types.js";

/** Lines without VAT: alanyi and tárgyi adómentes, out of scope, reverse charge. */

const seller: Party = { name: "Minta Bt.", address: "Fő utca 1.", postcode: "1011", city: "Budapest", taxNumber: "12345678-2-41" };
const person: Party = { name: "Teszt Vevő", address: "Kossuth utca 5.", postcode: "9021", city: "Győr" };
const company: Party = { ...person, name: "Példa Kft.", taxNumber: "87654321-2-08" };
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const format = { prefix: "SZ" };

const tam: LineInput = {
  description: "Tanfolyam",
  quantity: 1,
  unit: "db",
  unitPriceGross: 50_000,
  vatRate: 0,
  vatExemption: { case: "TAM", reason: "Áfa tv. 85. § (1) e)" },
};
const standard: LineInput = { description: "Jegyzet", quantity: 2, unit: "db", unitPriceGross: 2540, vatRate: 27 };

const input = (lines: LineInput[], buyer: Party = person): IssueInput => ({
  seller,
  buyer,
  lines,
  issueDate: day("2026-11-02"),
  fulfilmentDate: day("2026-11-02"),
  dueDate: day("2026-11-02"),
  paymentMethod: "transfer",
});
const issue = (lines: LineInput[], buyer?: Party) => issueInvoice(input(lines, buyer), { sequence: inMemorySequence(), numberFormat: format });

test("a line without VAT has its net equal to its gross, and its own summary row", async () => {
  const invoice = await issue([standard, tam]);
  const exempt = invoice.lines[1]!;
  assert.equal(exempt.lineNet, 50_000);
  assert.equal(exempt.lineVat, 0);
  assert.deepEqual(
    invoice.vatSummary.map((row) => [row.vatRate, row.vatExemption?.case ?? null, row.net, row.vat]),
    [
      [27, null, 4000, 1080],
      [0, "TAM", 50_000, 0],
    ],
  );
  assert.equal(invoice.totalGross, 55_080);
});

test("different exemptions are summed apart, though all are 0%", async () => {
  const atk: LineInput = { ...tam, description: "Kártérítés", vatExemption: { case: "ATK", reason: "Az Áfa tv. hatályán kívüli ügylet" } };
  const invoice = await issue([tam, atk, tam]);
  assert.deepEqual(
    invoice.vatSummary.map((row) => [row.vatExemption?.case, row.net]),
    [
      ["TAM", 100_000],
      ["ATK", 50_000],
    ],
  );
});

test("0% without a reason, and a reason without 0%, are refused before a number is drawn", async () => {
  const sequence = inMemorySequence();
  const attempt = (line: LineInput) => issueInvoice(input([line]), { sequence, numberFormat: format });
  await assert.rejects(() => attempt({ ...standard, vatRate: 0 }), /no vatExemption/);
  await assert.rejects(() => attempt({ ...tam, vatRate: 27 }), /must be 0/);
  await assert.rejects(() => attempt({ ...tam, vatExemption: { case: "TAM", reason: " " } }), /reason/);
  await assert.rejects(() => attempt({ ...tam, vatExemption: { case: "XYZ" as "TAM", reason: "x" } }), /AAM, TAM, ATK or REVERSE_CHARGE/);
  assert.equal(await sequence.next(), 1, "no number was used up");
});

test("an alanyi adómentes invoice is AAM on every line", async () => {
  const aam: LineInput = { ...tam, vatExemption: { case: "AAM", reason: "Alanyi adómentes" } };
  assert.equal((await issue([aam, aam])).totalVat, 0);
  await assert.rejects(() => issue([aam, standard]), /alanyi adómentes/);
});

test("reverse charge needs a buyer with a tax number", async () => {
  const reverse: LineInput = { ...tam, vatExemption: { case: "REVERSE_CHARGE", reason: "Fordított adózás" } };
  await assert.rejects(() => issue([reverse]), /tax number/);
  const invoice = await issue([reverse], company);
  assert.equal(invoice.totalVat, 0);
  assert.equal(invoice.totalGross, invoice.totalNet);
});

test("a storno keeps each line's exemption, and the PDF renders both", async () => {
  const sequence = inMemorySequence();
  const original = await issueInvoice(input([standard, tam]), { sequence, numberFormat: format });
  const storno = await stornoInvoice(original, { sequence, numberFormat: format, issueDate: day("2026-11-03") });
  assert.deepEqual(storno.lines[1]!.vatExemption, tam.vatExemption);
  assert.equal(storno.vatSummary[1]!.net, -50_000);
  for (const document of [original, storno]) {
    const pdf = await renderInvoicePdf(document, { createdAt: day("2026-11-02") });
    assert.ok(pdf.byteLength > 5000);
  }
});
