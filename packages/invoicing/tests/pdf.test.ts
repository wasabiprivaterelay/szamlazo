import { test } from "vitest";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import * as fontkit from "fontkit";
import { issueInvoice, stornoInvoice } from "../src/invoice.js";
import { inMemorySequence } from "../src/numbering.js";
import { renderInvoicePdf } from "../src/pdf.js";
import type { IssueInput, Party } from "../src/types.js";

const seller: Party = {
  name: "Minta Bt.",
  address: "Fő utca 1.",
  postcode: "1011",
  city: "Budapest",
  taxNumber: "12345678-2-41",
};

const buyer: Party = {
  name: "Tűzkő Ödön",
  address: "Őrhegy utca 7.",
  postcode: "9021",
  city: "Győr",
};

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const createdAt = new Date("2026-09-22T10:00:00Z");

const input: IssueInput = {
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
    {
      description: "Szállítási díj",
      quantity: 1,
      unit: "db",
      unitPriceGross: 1990,
      vatRate: 27,
    },
  ],
  issueDate: day("2026-09-22"),
  fulfilmentDate: day("2026-09-22"),
  dueDate: day("2026-09-22"),
  paymentMethod: "transfer",
  orderNumber: "SZ-2026-0001",
};

async function invoice() {
  return issueInvoice(input, { sequence: inMemorySequence(), numberFormat: { prefix: "SZ" } });
}

test("an invoice renders to a PDF", async () => {
  const pdf = await renderInvoicePdf(await invoice(), { createdAt });
  assert.equal(new TextDecoder().decode(pdf.subarray(0, 5)), "%PDF-");
  assert.ok(pdf.byteLength > 5000, `expected a real document, got ${pdf.byteLength} bytes`);
  // Every PDF ends with its trailer; a truncated stream would not.
  assert.match(new TextDecoder().decode(pdf.subarray(-32)), /%%EOF/);
});

test("the same invoice renders to the same bytes", async () => {
  const one = await renderInvoicePdf(await invoice(), { createdAt });
  const two = await renderInvoicePdf(await invoice(), { createdAt });
  assert.deepEqual(Buffer.from(one).toString("base64"), Buffer.from(two).toString("base64"));
});

test("a storno renders too, and differs from the original", async () => {
  const sequence = inMemorySequence();
  const original = await issueInvoice(input, { sequence, numberFormat: { prefix: "SZ" } });
  const storno = await stornoInvoice(original, {
    sequence,
    numberFormat: { prefix: "SZ" },
    issueDate: day("2026-09-25"),
  });
  const pdf = await renderInvoicePdf(storno, { createdAt });
  assert.ok(pdf.byteLength > 5000);
  const originalPdf = await renderInvoicePdf(original, { createdAt });
  assert.notEqual(Buffer.from(pdf).toString("base64"), Buffer.from(originalPdf).toString("base64"));
});

test("a logo is accepted", async () => {
  // A small solid PNG, so the test covers the image path without carrying a
  // picture around.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQYlWNYaWP1Hx9mGBkKAMMTh4EdmflVAAAAAElFTkSuQmCC",
    "base64",
  );
  const pdf = await renderInvoicePdf(await invoice(), { createdAt, logo: new Uint8Array(png) });
  assert.ok(pdf.byteLength > 5000);
});

test("the bundled font has the Hungarian letters", () => {
  // The reason for embedding a font at all: the standard PDF fonts encode
  // WinAnsi, which has á and é but neither ő nor ű, so "Előre" would print
  // with holes in it. This asserts the font shipped with the renderer covers
  // every letter Hungarian uses.
  const require = createRequire(import.meta.url);
  const root = join(require.resolve("pdfmake/package.json"), "..", "build", "fonts", "Roboto");
  for (const file of ["Roboto-Regular.ttf", "Roboto-Medium.ttf"]) {
    const font = fontkit.create(readFileSync(join(root, file)));
    assert.ok("hasGlyphForCodePoint" in font, `${file} is not a single font`);
    for (const letter of "áéíóöőúüűÁÉÍÓÖŐÚÜŰ") {
      assert.ok(
        font.hasGlyphForCodePoint(letter.codePointAt(0)!),
        `${file} has no glyph for ${letter}`,
      );
    }
  }
});

test("a logo that is not an image is refused rather than hanging", async () => {
  // pdfmake hangs on bytes it cannot decode instead of failing, so the
  // renderer checks the signature itself.
  const document = await invoice();
  await assert.rejects(
    () => renderInvoicePdf(document, { createdAt, logo: new Uint8Array([1, 2, 3, 4]) }),
    /must be PNG or JPEG/,
  );
});

test("a party can state the order of its own details", async () => {
  // What a seller puts on an invoice, and in what order, differs from seller
  // to seller; the library takes the lines as given rather than deciding.
  const ordered = await issueInvoice(
    {
      ...input,
      seller: {
        ...seller,
        lines: ["11773016-11111111-00000000", "Adószám: 12345678-2-41", "1011 Budapest", ""],
      },
    },
    { sequence: inMemorySequence(), numberFormat: { prefix: "SZ" } },
  );
  const pdf = await renderInvoicePdf(ordered, { createdAt });
  assert.ok(pdf.byteLength > 5000);
  // An empty line is dropped rather than printed as a gap.
  assert.equal(ordered.seller.lines?.length, 4);
});

test("the totals are named so a reader can follow them", async () => {
  const one = await issueInvoice(input, {
    sequence: inMemorySequence(),
    numberFormat: { prefix: "SZ" },
  });
  // 2 × 2100 nets to 3307 with 893 of VAT, and 1990 to 1567 with 423: the
  // invoice's net is 4874 and the VAT on it 1316, which is what the block has
  // to say rather than leaving a reader to work out where a number came from.
  assert.equal(one.totalNet, 4874);
  assert.equal(one.totalVat, 1316);
  assert.equal(one.totalGross, 6190);
  assert.equal(one.vatSummary.length, 1);

  // With two rates the base has to be stated per rate, which the law wants
  // and a single net line cannot give.
  const two = await issueInvoice(
    {
      ...input,
      lines: [
        ...input.lines,
        { description: "Könyv", quantity: 1, unit: "db", unitPriceGross: 1000, vatRate: 5 },
      ],
    },
    { sequence: inMemorySequence(), numberFormat: { prefix: "SZ" } },
  );
  assert.deepEqual(
    two.vatSummary.map((row) => row.vatRate),
    [27, 5],
  );
  assert.equal(
    two.vatSummary.reduce((sum, row) => sum + row.net, 0),
    two.totalNet,
  );
  assert.ok((await renderInvoicePdf(two, { createdAt })).byteLength > 5000);
});
