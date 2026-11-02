# @szamlazo/nav

A client for NAV Online Számla, API version 3.0, in TypeScript for Node.js:
report invoices and stornos, follow them until NAV decides, look up tax
numbers, and read back what NAV holds. Plus a command-line tool that proves a
technical user works and sends a test invoice in one command.

It is the NAV part of [szamlazo](../../README.md) and has no dependency on the
rest: no database, no framework. One runtime dependency (`fast-xml-parser`).

```ts
import { navClientFromEnv } from "@szamlazo/nav";

const nav = navClientFromEnv(process.env);
const { transactionId } = await nav.manageInvoice([{ operation: "CREATE", invoice }]);
const status = await nav.queryTransactionStatus(transactionId);
// { finished: true, invoices: [{ index: 1, status: "DONE", messages: [] }] }
```

## Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Getting NAV credentials](#getting-nav-credentials)
- [Configuration](#configuration)
- [Command line](#command-line)
- [Reporting an invoice](#reporting-an-invoice)
- [Reversing an invoice (storno)](#reversing-an-invoice-storno)
- [Other operations](#other-operations)
- [Errors](#errors)
- [What it covers](#what-it-covers)
- [Tests](#tests)

## Requirements

- Node.js 22 or newer (uses the built-in `fetch` and `node:crypto`'s SHA3).
- A NAV technical user, on the test system to start with.

## Installation

From this repository (a workspace package):

```sh
git clone https://github.com/wasabiprivaterelay/szamlazo.git
cd szamlazo && npm ci && npm run build:libs
```

In another project, depend on the built package: `npm install
/path/to/szamlazo/packages/nav`, or from npm once published,
`npm install @szamlazo/nav`.

## Getting NAV credentials

Step by step:
[docs/nav-test-environment.md](../../docs/nav-test-environment.md). In short:
log in to [onlineszamla-test.nav.gov.hu](https://onlineszamla-test.nav.gov.hu/)
with Ügyfélkapu+ or DÁP as the primary user, create a **technical user** with
the rights to manage and query invoices, and generate its keys. You get four
values: login, password, signing key, exchange key. The live system
([onlineszamla.nav.gov.hu](https://onlineszamla.nav.gov.hu/)) needs its own
technical user; test keys do not work there.

## Configuration

### From the environment

```sh
NAV_ENVIRONMENT=test              # test | production
NAV_LOGIN=…                       # the technical user
NAV_PASSWORD=…
NAV_SIGNING_KEY=…                 # "XML aláírókulcs"
NAV_EXCHANGE_KEY=…                # "XML cserekulcs", 16 characters
NAV_TAX_NUMBER=12345678           # 8 digits, or the full 11
NAV_SOFTWARE_DEV_NAME=Minta Kft.  # who runs the software
NAV_SOFTWARE_DEV_CONTACT=it@example.hu
# Optional: NAV_SOFTWARE_ID (18 chars, default <tax number>SZAMLAZO-1),
# NAV_SOFTWARE_NAME, NAV_SOFTWARE_OPERATION, NAV_SOFTWARE_VERSION,
# NAV_SOFTWARE_DEV_TAX_NUMBER
```

```ts
import { navClientFromEnv, NavConfigError } from "@szamlazo/nav";

try {
  const nav = navClientFromEnv(process.env, { timeoutMs: 30_000 });
} catch (error) {
  if (error instanceof NavConfigError) console.error(error.message); // names what is missing
}
```

### In code

```ts
import { NavClient, checkCredentials, checkSoftware } from "@szamlazo/nav";

const credentials = {
  login: "abcdef123456",
  password: "…",
  signingKey: "…",
  exchangeKey: "…",          // exactly 16 bytes
  taxNumber: "12345678",     // the first eight digits
};
const software = {
  softwareId: "12345678SZAMLAZO-1",   // [0-9A-Z-]{18}
  softwareName: "szamlazo",
  softwareOperation: "ONLINE_SERVICE" as const,   // or LOCAL_SOFTWARE
  softwareMainVersion: "1.0",
  softwareDevName: "Minta Kft.",
  softwareDevContact: "it@example.hu",
  softwareDevCountryCode: "HU",
};
checkCredentials(credentials);   // throws with a precise reason
checkSoftware(software);

const nav = new NavClient({ environment: "test", credentials, software });
```

## Command line

The package ships `nav-online-szamla`. From the repository root it runs as
`npm run nav -- <command>` and reads `.env`.

```
check                         token exchange and a lookup of your own tax number
taxpayer <tax number> [...]   what NAV knows about a tax number
digest <from> <to> [--inbound]
                              invoices NAV holds for a period (at most 35 days)
invoice <number> [--inbound]  one invoice as NAV stored it (the XML)
status <transaction id>       the verdict on a submission
test-invoice [--storno]       send a made-up invoice to the TEST system, wait for
                              the verdict; with --storno reverse it as well
```

```sh
$ npm run nav -- check
NAV test system

token exchange   ok (token valid until 2026-11-02T12:05:00.000Z)
taxpayer lookup  ok: MINTA KFT. (12345678-2-41)

The technical user, the signing key and the exchange key all work.
```

`test-invoice` refuses to run against production. Exit codes: `0` success,
`1` NAV refused or failed, `64` wrong usage, `65` text XML cannot carry,
`78` configuration missing.

## Reporting an invoice

Amounts are in the invoice's currency (forints by default), with up to two
decimals. Rates are percentages: `27`, not `0.27`.

```ts
import type { NavInvoice, NavLine } from "@szamlazo/nav";

const invoice: NavInvoice = {
  invoiceNumber: "SZ2026/00001",
  issueDate: "2026-11-02",
  deliveryDate: "2026-11-02",          // teljesítés dátuma
  paymentDate: "2026-11-02",           // due date
  paymentMethod: "CARD",               // TRANSFER | CASH | CARD | VOUCHER | OTHER
  currency: "HUF",
  supplier: {
    name: "Minta Kft.",
    taxpayerId: "12345678", vatCode: "2", countyCode: "41",
    postalCode: "1011", city: "Budapest", address: "Fő utca 1.",
    bankAccount: "11773016-11111111-00000000",
  },
  customer: {
    name: "Kiss Anna",
    postalCode: "1052", city: "Budapest", address: "Váci utca 10.",
  },
  // A private person's name and address are not reported to NAV (the law
  // forbids it); DOMESTIC for a Hungarian business, with taxpayerId, vatCode…
  customerVatStatus: "PRIVATE_PERSON",
  lines: [{
    lineNumber: 1,
    description: "Kerámia bögre",
    quantity: 2,
    unitOfMeasure: "PIECE",            // or OWN with unitOfMeasureOwn: "csomag"
    unitPriceNet: 3929,
    netAmount: 7858, vatAmount: 2122, grossAmount: 9980,
    vatRate: 27,
  }],
  vatSummary: [{ vatRate: 27, net: 7858, vat: 2122 }],
  totalNet: 7858, totalVat: 2122, totalGross: 9980,
};

const { transactionId } = await nav.manageInvoice([{ operation: "CREATE", invoice }]);
```

`manageInvoice` exchanges a token, builds and signs the request (SHA-512
password hash, SHA3-512 signature over the request id, timestamp, signing key
and every invoice's data) and returns NAV's transaction id. NAV then
processes it asynchronously; ask for the verdict:

```ts
for (;;) {
  const { finished, invoices } = await nav.queryTransactionStatus(transactionId);
  if (finished) {
    // invoices[0].status: DONE (accepted), ABORTED (rejected), messages: NAV's reasons
    break;
  }
  await new Promise((r) => setTimeout(r, 3000));
}
```

Up to 100 invoices can go in one `manageInvoice` call; `index` in the status
says which is which.

**Before resending after a timeout, ask.** A request can reach NAV while its
answer is lost. `queryInvoiceData(number)` returns `null` if NAV does not have
the invoice; anything else means it does, and sending it again would be a
duplicate report.

### Lines without VAT

`vatRate: 0` plus `vatExemption`, on the line and on its summary row:

```ts
const course: NavLine = {
  description: "Nyelvtanfolyam", quantity: 1, unitOfMeasure: "PIECE",
  unitPriceNet: 60000, netAmount: 60000, vatAmount: 0, grossAmount: 60000,
  vatRate: 0,
  vatExemption: { case: "TAM", reason: "Áfa tv. 85. § (1) e)" },
};
// vatSummary: [{ vatRate: 0, vatExemption: course.vatExemption, net: 60000, vat: 0 }]
```

| `case` | Reported as |
|---|---|
| `AAM`, `TAM` | `<vatExemption><case>…</case><reason>…</reason></vatExemption>` |
| `ATK` | `<vatOutOfScope><case>ATK</case><reason>…</reason></vatOutOfScope>` |
| `REVERSE_CHARGE` | `<vatDomesticReverseCharge>true</vatDomesticReverseCharge>` (buyer must be `DOMESTIC`) |

The reason is at most 200 characters and is what the invoice prints as its
legal ground.

## Reversing an invoice (storno)

A storno is a new invoice with its own number that reverses the original
line by line. Two numbering rules apply (specification 2.5.1):
`lineNumber` counts this document's lines from 1, while
`modifies.lineNumberReference` continues the chain after the original's
lines.

```ts
const storno: NavInvoice = {
  ...invoice,
  invoiceNumber: "SZ2026/00002",
  issueDate: "2026-11-03",
  reverses: "SZ2026/00001",
  modificationIndex: 1,                // first correction of that invoice
  lines: invoice.lines.map((line, i) => ({
    ...line,
    lineNumber: i + 1,
    modifies: { lineNumberReference: invoice.lines.length + i + 1, operation: "CREATE" },
    quantity: -line.quantity,
    netAmount: -line.netAmount, vatAmount: -line.vatAmount, grossAmount: -line.grossAmount,
  })),
  vatSummary: invoice.vatSummary.map((row) => ({ ...row, net: -row.net, vat: -row.vat })),
  totalNet: -invoice.totalNet, totalVat: -invoice.totalVat, totalGross: -invoice.totalGross,
};
await nav.manageInvoice([{ operation: "STORNO", invoice: storno }]);
```

## Other operations

```ts
// A taxpayer: name, VAT and county digits, addresses, or { valid: false }
const taxpayer = await nav.queryTaxpayer("87654321");

// Everything NAV holds for a period (≤ 35 days), all pages
const list = await nav.queryInvoiceDigest("2026-11-01", "2026-11-30");            // issued
const received = await nav.queryInvoiceDigest("2026-11-01", "2026-11-30", "INBOUND");

// One invoice's XML as NAV stored it, with when and how it arrived
const stored = await nav.queryInvoiceData("SZ2026/00001");

// The XML alone, without sending it (for archives and tax inspection exports)
import { invoiceDataXml } from "@szamlazo/nav";
const xml = invoiceDataXml(invoice);

// Any other operation of the API, signed and parsed
const answer = await nav.call("queryInvoiceCheck", { body: [/* elements */] });
```

## Errors

Everything NAV refuses throws `NavError`:

```ts
import { NavError } from "@szamlazo/nav";

try {
  await nav.manageInvoice([{ operation: "CREATE", invoice }]);
} catch (error) {
  if (error instanceof NavError) {
    error.errorCode;    // "INVALID_SECURITY_USER", "SCHEMA_VIOLATION", … or undefined for HTTP failures
    error.operation;    // "manageInvoice"
    error.requestId;    // quote this when asking NAV
    error.validations;  // NAV's line-by-line reasons, when it gives them
  }
}
```

A network error or the timeout (30 s by default) throws the platform's own
error. Text containing characters XML cannot carry (control characters, lone
surrogates) throws `InvalidXmlText` before anything is sent.

| `errorCode` | Usually |
|---|---|
| `INVALID_SECURITY_USER` | Wrong login, password or tax number, or a test user on the live system |
| `INVALID_REQUEST_SIGNATURE` | Wrong signing key |
| `NOT_REGISTERED_CUSTOMER` | The taxpayer has not finished registering on this system |
| `SCHEMA_VIOLATION` | The XML does not match NAV's schema (a bug: please report it) |
| `OPERATION_FAILED`, HTTP 5xx, timeouts | NAV is down or overloaded; retry later |

## What it covers

- Operations: `tokenExchange`, `manageInvoice` (CREATE, STORNO, MODIFY),
  `queryTransactionStatus`, `queryInvoiceData`, `queryInvoiceDigest`,
  `queryTaxpayer`; any other through `call`.
- Invoice data: domestic sales in any currency the caller states, VAT rates as
  percentages, private persons and Hungarian businesses as buyers, standard
  and own units of measure.
- VAT: percentages, and lines without VAT: tárgyi and alanyi adómentes
  (`vatExemption` TAM, AAM), out of scope (`vatOutOfScope` ATK) and domestic
  reverse charge (`vatDomesticReverseCharge`).
- Not modelled yet: EU and foreign buyers (KBAET, EAM, …), advance invoices,
  cash accounting, margin scheme, product codes, discounts as separate lines.
  Contributions welcome.

Generated invoice XML, with every VAT treatment, has been validated against
NAV's published XSDs (`invoiceData.xsd`, `invoiceBase.xsd`, NTCA
`common.xsd` 1.0).

The specification: [NAV Online Számla API documentation](https://github.com/nav-gov-hu/Online-Invoice)
(interface specification and XSDs, version 3.0).

## Tests

```sh
npm test -w @szamlazo/nav
```

Signatures, hashes and token decryption are checked against known values
(including that the hash is SHA3-512, not Keccak, which differ); request and
invoice XML for element order, namespaces and escaping; the client against a
fake NAV. No test talks to NAV; `npm run nav --
test-invoice` does that, by hand.

## License

[MIT](LICENSE).
