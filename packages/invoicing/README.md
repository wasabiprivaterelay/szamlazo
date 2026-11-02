# @szamlazo/invoicing

Hungarian invoices as plain data: the amounts, a gapless number, a storno,
and a PDF that prints ő and ű. No database, no network, no knowledge of any
particular business: you hand it a seller, a buyer and some lines, and it
hands back an invoice and its PDF bytes.

It is the invoice part of [szamlazo](../../README.md), usable on its own in
any Node.js program. One runtime dependency, `pdfmake`.

```ts
import { issueInvoice, renderInvoicePdf, inMemorySequence } from "@szamlazo/invoicing";

const invoice = await issueInvoice(input, { sequence, numberFormat: { prefix: "SZ" } });
const pdf = await renderInvoicePdf(invoice, { logo, accentColour: "#1d4f86" });
```

## Contents

- [Installation](#installation)
- [Issuing an invoice](#issuing-an-invoice)
- [How amounts are worked out](#how-amounts-are-worked-out)
- [Numbering: bring your own sequence](#numbering-bring-your-own-sequence)
- [Storno](#storno)
- [The PDF](#the-pdf)
- [Reference](#reference)
- [What it does not do](#what-it-does-not-do)

## Installation

Node.js 22 or newer. From this repository:

```sh
git clone https://github.com/wasabiprivaterelay/szamlazo.git
cd szamlazo && npm ci && npm run build:libs
```

In another project: `npm install /path/to/szamlazo/packages/invoicing`, or
`npm install @szamlazo/invoicing` once published.

## Issuing an invoice

```ts
import { writeFile } from "node:fs/promises";
import { issueInvoice, renderInvoicePdf, inMemorySequence } from "@szamlazo/invoicing";

const sequence = inMemorySequence();   // for trying it out; see "Numbering" for production

const invoice = await issueInvoice(
  {
    seller: {
      name: "Minta Kft.",
      address: "Fő utca 1.",
      postcode: "1011",
      city: "Budapest",
      taxNumber: "12345678-2-41",
      registrationNumber: "01-09-123456",
      bankAccount: "11773016-11111111-00000000",
    },
    buyer: {
      name: "Tűzkő Ödönné",
      address: "Őrhegyi utca 7.",
      postcode: "9021",
      city: "Győr",
    },
    lines: [
      { description: "Gyapjú sál", quantity: 2, unit: "db", unitPriceGross: 2100, vatRate: 27 },
      { description: "Könyv", quantity: 1, unit: "db", unitPriceGross: 3990, vatRate: 5 },
    ],
    issueDate: new Date("2026-11-02"),
    fulfilmentDate: new Date("2026-11-02"),
    dueDate: new Date("2026-11-10"),
    paymentMethod: "transfer",            // card | transfer | cash | other
    note: "Köszönjük a vásárlást!",
    orderNumber: "1001",                  // printed as "Hivatkozás"
  },
  { sequence, numberFormat: { prefix: "SZ" } },
);

invoice.invoiceNumber;   // "SZ2026/00001"
invoice.totalGross;      // 8190
invoice.vatSummary;      // one row per rate: [{ vatRate: 27, … }, { vatRate: 5, … }]

await writeFile("SZ2026-00001.pdf", await renderInvoicePdf(invoice));
```

The seller must have a tax number; a private buyer need not. Missing names or
addresses throw before a number is drawn.

## How amounts are worked out

Prices go in **gross** (VAT included), as Hungarian retail prices are quoted,
and money is **whole forints**. Per line:

```
gross = unitPriceGross × quantity
net   = round(gross × 100 / (100 + vatRate))     half away from zero
vat   = gross − net
```

The totals and the VAT summary are sums of the lines, never the gross total
netted again, so an invoice's lines always add up to its totals. Nothing
returns a fraction, so no rounding hides in an intermediate value. Rounding is
half away from zero, so a storno is the exact negative of its original
(`Math.round` would make it a forint out).

The same arithmetic is exported: `lineAmounts`, `totalsOfLines`,
`netOfGross`, `vatOfGross`, `roundHalfAwayFromZero`.

## Numbering: bring your own sequence

Numbers look like `SZ2026/00001`: prefix, the issue date's year, a counter.
The counter must never skip and never repeat, and a library cannot promise
that alone: it needs something atomic. So you pass a `SequenceSource`:

```ts
type SequenceSource = { next(): Promise<number> };
```

`issueInvoice` draws the number **last**, after everything that could fail.
In production, implement `next()` as a locked database row incremented
**inside the same transaction** that stores the invoice, so a failure after
it gives the number back. The server's version, in
[`packages/server/src/db/sequence.ts`](../server/src/db/sequence.ts):

```sql
update invoice_sequence set last_number = last_number + 1
where id = (select id from invoice_sequence where id = 1 for update)
returning last_number
```

`inMemorySequence()` is for tests and trying things out, never production.

## Storno

```ts
import { stornoInvoice } from "@szamlazo/invoicing";

const storno = await stornoInvoice(invoice, {
  sequence,
  numberFormat: { prefix: "SZ" },
  issueDate: new Date("2026-11-05"),
  note: "A rendelés lemondva.",
});

storno.type;                    // "storno"
storno.originalInvoiceNumber;   // "SZ2026/00001"
storno.totalGross;              // -8190
```

Every line is reversed (negative quantities and amounts); parties, dates and
payment method are copied from the original, because a storno states what
the original stated. A storno takes its number from the same sequence, and
cannot itself be reversed.

## The PDF

`renderInvoicePdf(invoice, options)` resolves with the PDF's bytes: one A4
page (more for long invoices) with every field the law asks for, in
Hungarian.

| Option | |
|---|---|
| `logo` | PNG or JPEG bytes, printed top left |
| `logoWidth` | Points, default 96 |
| `accentColour` | Headings and rules, e.g. `#1d4f86` |
| `title` | Default `Számla` |
| `footer` | Small print at the bottom |
| `createdAt` | Fixes the PDF's creation time, so the same invoice renders to the same bytes, which is what makes a stored SHA-256 meaningful |

The PDF embeds Roboto, because the standard PDF fonts encode WinAnsi, which
has `á` and `é` but neither `ő` nor `ű`. Rendering reads those font files and
nothing else: no network request, no other file opened.

## Reference

| Export | |
|---|---|
| `issueInvoice(input, { sequence, numberFormat })` | Prices the lines, totals them, draws a number |
| `stornoInvoice(original, { sequence, numberFormat, issueDate, note? })` | The reversal |
| `renderInvoicePdf(invoice, options?)` | `Promise<Uint8Array>` |
| `formatInvoiceNumber(n, year, format)`, `parseInvoiceNumber(s)` | Numbers both ways |
| `inMemorySequence(from?)` | A counter for tests |
| `lineAmounts`, `totalsOfLines`, `vatSummaryOf`, `netOfGross`, `vatOfGross`, `roundHalfAwayFromZero` | The arithmetic |
| `formatMoney`, `formatAmount`, `formatDateHu`, `formatTaxNumber`, `paymentMethodLabel` | Hungarian formatting, as printed |
| Types: `Party`, `LineInput`, `InvoiceLine`, `Invoice`, `IssueInput`, `VatSummaryRow`, `PaymentMethod`, `NumberFormat`, `SequenceSource`, `PdfOptions` | |

**Dates are calendar days, read in UTC.** Pass `new Date("2026-11-02")`, not
a date built from local parts, or an invoice issued late in the evening in
Budapest is dated the day before.

## What it does not do

- **Own the sequence** (see above), **store** anything, or **report to NAV**:
  that is [`@szamlazo/nav`](../nav), and putting them together is
  [the server](../server).
- Net-priced lines, fractional quantities,
  foreign currencies on the PDF's totals, modifying invoices. See
  [docs/limits.md](../../docs/limits.md).

## Tests

```sh
npm test -w @szamlazo/invoicing
```

## License

[MIT](LICENSE).
