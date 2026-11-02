import { test } from "vitest";
import assert from "node:assert/strict";
import { issueInvoice, stornoInvoice, vatSummaryOf } from "../src/invoice.js";
import { inMemorySequence, formatInvoiceNumber, parseInvoiceNumber } from "../src/numbering.js";
import type { IssueInput, Party } from "../src/types.js";

const seller: Party = {
  name: "Minta Bt.",
  address: "Fő utca 1.",
  postcode: "1011",
  city: "Budapest",
  taxNumber: "12345678-2-41",
  registrationNumber: "10091279",
  bankAccount: "11773016-11111111-00000000",
};

const buyer: Party = {
  name: "Teszt Vevő",
  address: "Kossuth utca 5.",
  postcode: "9021",
  city: "Győr",
};

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

function input(overrides: Partial<IssueInput> = {}): IssueInput {
  return {
    seller,
    buyer,
    lines: [
      {
        description: "Gyapjú sál",
        quantity: 2,
        unit: "db",
        unitPriceGross: 2100,
        vatRate: 27,
      },
    ],
    issueDate: day("2026-09-22"),
    fulfilmentDate: day("2026-09-22"),
    dueDate: day("2026-09-22"),
    paymentMethod: "transfer",
    orderNumber: "SZ-2026-0001",
    ...overrides,
  };
}

const format = { prefix: "SZ" };

test("an invoice numbers itself from the sequence and the year of issue", async () => {
  const sequence = inMemorySequence();
  const first = await issueInvoice(input(), { sequence, numberFormat: format });
  const second = await issueInvoice(input(), { sequence, numberFormat: format });
  assert.equal(first.invoiceNumber, "SZ2026/00001");
  assert.equal(second.invoiceNumber, "SZ2026/00002");
});

test("the year comes from the date in UTC, not from the local clock", async () => {
  // 31 December 23:30 in Budapest is already the new year in UTC+1, and an
  // invoice dated the 31st must be numbered with that year whatever the
  // server's time zone.
  const issueDate = new Date("2026-12-31T22:30:00Z");
  const invoice = await issueInvoice(input({ issueDate }), {
    sequence: inMemorySequence(),
    numberFormat: format,
  });
  assert.equal(invoice.invoiceNumber, "SZ2026/00001");
});

test("line amounts and totals follow the rounding rule", async () => {
  const invoice = await issueInvoice(input(), {
    sequence: inMemorySequence(),
    numberFormat: format,
  });
  const line = invoice.lines[0]!;
  assert.equal(line.lineGross, 4200);
  // 4200 * 100 / 127 = 3307.08..., which rounds to 3307.
  assert.equal(line.lineNet, 3307);
  assert.equal(line.lineVat, 893);
  assert.equal(invoice.totalGross, 4200);
  assert.equal(invoice.totalNet, 3307);
  assert.equal(invoice.totalVat, 893);
  assert.equal(invoice.totalNet + invoice.totalVat, invoice.totalGross);
});

test("totals are the sums of the lines, not the gross recalculated", async () => {
  // Three lines of 2100 net to 1654 each: summing the lines gives 4962, while
  // netting the 6300 total in one go would give 4961. The invoice must show
  // the first, so that its lines add up to its total.
  const invoice = await issueInvoice(
    input({
      lines: [
        { description: "A", quantity: 1, unit: "db", unitPriceGross: 2100, vatRate: 27 },
        { description: "B", quantity: 1, unit: "db", unitPriceGross: 2100, vatRate: 27 },
        { description: "C", quantity: 1, unit: "db", unitPriceGross: 2100, vatRate: 27 },
      ],
    }),
    { sequence: inMemorySequence(), numberFormat: format },
  );
  assert.equal(invoice.totalNet, 4962);
  assert.equal(invoice.totalVat, 1338);
  assert.equal(invoice.totalGross, 6300);
  assert.equal(
    invoice.lines.reduce((sum, line) => sum + line.lineNet, 0),
    invoice.totalNet,
  );
});

test("VAT is summarised per rate, in the order the rates appear", async () => {
  const invoice = await issueInvoice(
    input({
      lines: [
        { description: "Lé", quantity: 1, unit: "db", unitPriceGross: 2100, vatRate: 27 },
        { description: "Könyv", quantity: 1, unit: "db", unitPriceGross: 1000, vatRate: 5 },
        { description: "Lé", quantity: 1, unit: "db", unitPriceGross: 2700, vatRate: 27 },
      ],
    }),
    { sequence: inMemorySequence(), numberFormat: format },
  );
  assert.deepEqual(
    invoice.vatSummary.map((row) => row.vatRate),
    [27, 5],
  );
  const standard = invoice.vatSummary.find((row) => row.vatRate === 27)!;
  assert.equal(standard.gross, 4800);
  assert.equal(standard.net + standard.vat, standard.gross);
  assert.equal(
    invoice.vatSummary.reduce((sum, row) => sum + row.gross, 0),
    invoice.totalGross,
  );
});

test("a storno reverses every amount and points at the original", async () => {
  const sequence = inMemorySequence();
  const original = await issueInvoice(input(), { sequence, numberFormat: format });
  const storno = await stornoInvoice(original, {
    sequence,
    numberFormat: format,
    issueDate: day("2026-09-25"),
    note: "Visszavett rendelés",
  });

  assert.equal(storno.type, "storno");
  assert.equal(storno.invoiceNumber, "SZ2026/00002");
  assert.equal(storno.originalInvoiceNumber, "SZ2026/00001");
  assert.equal(storno.totalGross, -original.totalGross);
  assert.equal(storno.totalNet, -original.totalNet);
  assert.equal(storno.totalVat, -original.totalVat);
  assert.equal(storno.lines[0]!.quantity, -2);
  assert.equal(storno.lines[0]!.lineGross, -4200);
  // The reversal states what the original stated, with a new issue date.
  assert.equal(storno.fulfilmentDate.toISOString(), original.fulfilmentDate.toISOString());
  assert.equal(storno.issueDate.toISOString(), day("2026-09-25").toISOString());
  assert.equal(storno.buyer.name, original.buyer.name);
});

test("a storno of a storno is refused", async () => {
  const sequence = inMemorySequence();
  const original = await issueInvoice(input(), { sequence, numberFormat: format });
  const storno = await stornoInvoice(original, {
    sequence,
    numberFormat: format,
    issueDate: day("2026-09-25"),
  });
  await assert.rejects(
    () => stornoInvoice(storno, { sequence, numberFormat: format, issueDate: day("2026-09-26") }),
    /cannot be reversed/,
  );
});

test("a storno and a normal invoice share one sequence", async () => {
  const sequence = inMemorySequence();
  const first = await issueInvoice(input(), { sequence, numberFormat: format });
  const storno = await stornoInvoice(first, {
    sequence,
    numberFormat: format,
    issueDate: day("2026-09-23"),
  });
  const third = await issueInvoice(input(), { sequence, numberFormat: format });
  assert.deepEqual(
    [first.invoiceNumber, storno.invoiceNumber, third.invoiceNumber],
    ["SZ2026/00001", "SZ2026/00002", "SZ2026/00003"],
  );
});

test("an invoice that cannot be built consumes no number", async () => {
  const sequence = inMemorySequence();
  await assert.rejects(
    () => issueInvoice(input({ lines: [] }), { sequence, numberFormat: format }),
    /at least one line/,
  );
  const next = await issueInvoice(input(), { sequence, numberFormat: format });
  assert.equal(next.invoiceNumber, "SZ2026/00001");
});

test("what an invoice must state is required", async () => {
  const options = { sequence: inMemorySequence(), numberFormat: format };
  await assert.rejects(
    () => issueInvoice(input({ seller: { ...seller, taxNumber: "" } }), options),
    /seller.taxNumber/,
  );
  await assert.rejects(
    () => issueInvoice(input({ buyer: { ...buyer, city: " " } }), options),
    /buyer.city/,
  );
  await assert.rejects(
    () =>
      issueInvoice(
        input({
          lines: [{ description: "X", quantity: 0, unit: "db", unitPriceGross: 100, vatRate: 27 }],
        }),
        options,
      ),
    /quantity of zero/,
  );
});

test("a private buyer needs no tax number", async () => {
  const invoice = await issueInvoice(input(), {
    sequence: inMemorySequence(),
    numberFormat: format,
  });
  assert.equal(invoice.buyer.taxNumber, undefined);
});

test("invoice numbers are written and read back the same way", () => {
  assert.equal(formatInvoiceNumber(1, 2026, { prefix: "SZ" }), "SZ2026/00001");
  assert.equal(formatInvoiceNumber(12345, 2026, { prefix: "SZ" }), "SZ2026/12345");
  assert.equal(formatInvoiceNumber(123456, 2026, { prefix: "SZ" }), "SZ2026/123456");
  assert.equal(formatInvoiceNumber(7, 2027, { prefix: "ABC", digits: 3 }), "ABC2027/007");
  assert.deepEqual(parseInvoiceNumber("SZ2026/00042"), { prefix: "SZ", year: 2026, sequence: 42 });
  assert.equal(parseInvoiceNumber("nem szám"), null);
  assert.throws(() => formatInvoiceNumber(0, 2026, { prefix: "SZ" }), /positive/);
  assert.throws(() => formatInvoiceNumber(1, 2026, { prefix: "la" }), /capital letters/);
});

test("the VAT summary of no lines is empty", () => {
  assert.deepEqual(vatSummaryOf([]), []);
});
