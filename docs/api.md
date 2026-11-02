# HTTP API

Base URL: wherever the server listens: `http://127.0.0.1:3000` locally,
`https://szamlazo.example.hu` behind the Cloudflare Tunnel.

- Every route under `/v1` needs `Authorization: Bearer szk_…`
  ([making a key](production.md#8-configuration)). Behind Cloudflare Access,
  also `CF-Access-Client-Id` and `CF-Access-Client-Secret`.
- Bodies are JSON, at most 256 KB. Unknown fields are refused, not ignored, so
  a typo never silently drops a value.
- Amounts are **whole forints**. Dates are `yyyy-mm-dd`, in Hungarian time.
- Responses are never cached (`Cache-Control: no-store`).

## Errors

Every error has the same shape:

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "The invoice request is not valid.",
    "details": [{ "path": "lines.0.vatRate", "message": "Invalid option: expected one of 5|18|27" }]
  }
}
```

| Status | Codes | Retry? |
|---|---|---|
| 400 | `INVALID_JSON`, `INVALID_REQUEST`, `INVALID_QUERY`, `INVALID_TAX_NUMBER` | No: fix the request |
| 401 | `UNAUTHORIZED` | No: the key is missing or wrong |
| 404 | `NOT_FOUND` | No |
| 409 | `REFERENCE_CONFLICT` | No: that reference already has a different invoice |
| 413 | `TOO_LARGE` | No |
| 422 | `TAXPAYER_INVALID`, `DATE_INVALID`, `VAT_INVALID`, `ALREADY_STORNO`, `NO_RECIPIENT` | No: the request is well-formed but cannot be done |
| 429 | `RATE_LIMITED` (600 requests a minute per key), `TOO_MANY_ATTEMPTS` (20 wrong keys in 10 minutes per address) | Yes, later |
| 500 | `INTERNAL`, `PDF_CHANGED` | `INTERNAL`: yes. `PDF_CHANGED`: no; see [operations.md](operations.md#pdf-changed) |
| 503 | `NAV_NOT_CONFIGURED`, `NAV_UNAVAILABLE`, `NO_MAILER` | `NAV_UNAVAILABLE`: yes |

## The invoice object

What every invoice route returns:

```json
{
  "id": "0b8f6c1e-7f0a-4c55-9a43-3d2f1e9c8a10",
  "invoiceNumber": "SZ2026/00001",
  "type": "normal",
  "reference": "order-1001",
  "reverses": null,
  "reversedBy": null,
  "issueDate": "2026-11-02",
  "fulfilmentDate": "2026-11-02",
  "dueDate": "2026-11-02",
  "seller": { "name": "Minta Kft.", "taxNumber": "12345678-2-41", "…": "…" },
  "buyer": { "name": "Kiss Anna", "postcode": "1052", "city": "Budapest", "address": "Váci utca 10.", "countryCode": "HU", "email": "anna@example.com" },
  "lines": [
    { "description": "Kerámia bögre", "quantity": 2, "unit": "db", "unitPriceGross": 4990, "vatRate": 27, "lineNet": 7858, "lineVat": 2122, "lineGross": 9980 }
  ],
  "totalNet": 7858,
  "totalVat": 2122,
  "totalGross": 9980,
  "currency": "HUF",
  "paymentMethod": "card",
  "note": null,
  "nav": { "status": "done", "transactionId": "4A1B…", "attempts": 1, "error": null },
  "email": { "to": "anna@example.com", "status": "sent", "sentAt": "2026-11-02T10:15:04.211Z" },
  "pdf": "/v1/invoices/0b8f6c1e-7f0a-4c55-9a43-3d2f1e9c8a10/pdf",
  "createdBy": "webshop",
  "createdAt": "2026-11-02T10:15:02.877Z"
}
```

- `type`: `normal`, or `storno` for a reversal. A storno has `reverses` (the
  original's number); an invoice that has been reversed has `reversedBy`.
- `nav.status`:

  | Value | Meaning |
  |---|---|
  | `queued` | Issued; the checker reports it within seconds |
  | `pending`, `sent` | On its way, or sent and waiting for NAV's verdict |
  | `done` | NAV accepted it |
  | `warning` | NAV accepted it with remarks (the invoice stands) |
  | `error` | NAV rejected it; `nav.error` says why, and you were alerted |
  | `not configured` | This server has no NAV technical user (development only) |

- `email` is `null` when the invoice is not emailed (no buyer email, or
  `sendEmail: false`). Otherwise `status` is `queued` (waiting for NAV to
  accept the invoice; it is never emailed before), `sent`, `failed` (being
  retried) or `bounced`.

## Issue an invoice

`POST /v1/invoices`

```json
{
  "reference": "order-1001",
  "buyer": {
    "type": "company",
    "name": "Példa Kft.",
    "postcode": "9021",
    "city": "Győr",
    "address": "Baross Gábor út 5.",
    "taxNumber": "87654321-2-08",
    "email": "konyveles@pelda.hu"
  },
  "lines": [
    { "description": "Gyapjú sál", "quantity": 1, "unit": "db", "unitPriceGross": 12700, "vatRate": 27 },
    { "description": "Könyv", "quantity": 3, "unit": "db", "unitPriceGross": 3990, "vatRate": 5 }
  ],
  "paymentMethod": "transfer",
  "fulfilmentDate": "2026-11-02",
  "note": "Rendelésszám: 1001"
}
```

| Field | Required | |
|---|---|---|
| `reference` | recommended | Your id for what is invoiced: 1–100 of `A-Z a-z 0-9 . _ : / # -`. The same reference with the same content returns the existing invoice (`200`, `"alreadyIssued": true`); with different content, `409 REFERENCE_CONFLICT`. Without it, every request issues a new invoice. |
| `buyer.type` | yes | `private` (a person buying for themselves) or `company` (anyone with a tax number: company, sole trader). |
| `buyer.name`, `postcode`, `city`, `address` | yes | Hungarian address; postcode four digits. |
| `buyer.taxNumber` | for `company` | All 11 digits. Checked with NAV before issuing: unknown, or with the wrong VAT or county digits, is `422 TAXPAYER_INVALID`. If NAV does not answer, the invoice is issued with the number as given. Not allowed for `private`. |
| `buyer.email` | no | Where the invoice is emailed. |
| `lines` | yes | 1–100 lines. |
| `lines[].description` | yes | Up to 500 characters. |
| `lines[].quantity` | yes | Whole number, 1 to 1 000 000. |
| `lines[].unit` | yes | As printed: `db`, `óra`, `kg`, `l`… Common Hungarian units are reported to NAV as their standard code, anything else as its own text. |
| `lines[].unitPriceGross` | yes | Whole forints, **VAT included**. |
| `lines[].vatRate` | yes | `27`, `18`, `5`, or `0` for a line without VAT. |
| `lines[].vatExemption` | with `vatRate: 0` | Why there is no VAT: `{ "case": "TAM", "reason": "Áfa tv. 85. § (1) e)" }`. See [Lines without VAT](#lines-without-vat). |
| `paymentMethod` | yes | `card`, `transfer`, `cash` or `other`. |
| `fulfilmentDate` | no | Teljesítés dátuma. Default: today. Not more than a year from today. |
| `dueDate` | no | Fizetési határidő. Default: today, or `PAYMENT_TERM_DAYS` ahead for `transfer`. Not before today. |
| `note` | no | Printed on the invoice; up to 1 000 characters, line breaks allowed. |
| `sendEmail` | no | Default `true`: email `buyer.email` once NAV accepts. |

### Lines without VAT

A line with `vatRate: 0` must say why, in `vatExemption`:

| `case` | Meaning | `reason` | Printed as |
|---|---|---|---|
| `TAM` | Tárgyi adómentes: the supply is exempt (Áfa tv. 85.–86. §), e.g. education, healthcare, financial services | **Required**: the exact legal ground, e.g. `Áfa tv. 85. § (1) e)` | `TAM` |
| `ATK` | Outside the scope of the VAT act (e.g. a penalty, compensation) | Optional; default `Az Áfa tv. hatályán kívüli ügylet` | `ÁKK` |
| `REVERSE_CHARGE` | Belföldi fordított adózás (Áfa tv. 142. §): the buyer pays the VAT, e.g. construction services | Optional; default `Fordított adózás (Áfa tv. 142. §)`. Only for a `company` buyer | `FAD` |
| `AAM` | Alanyi adómentes: the **seller** is exempt | Optional; default `Alanyi adómentes (Áfa tv. XIII. fejezet)`. Only when the server has `SELLER_AAM=true`, and then every line is AAM | `AAM` |

```json
{ "description": "Nyelvtanfolyam", "quantity": 1, "unit": "db", "unitPriceGross": 60000,
  "vatRate": 0, "vatExemption": { "case": "TAM", "reason": "Áfa tv. 85. § (1) e)" } }
```

For a line without VAT, net = gross and VAT = 0. The PDF prints each reason
under the totals, as the law requires, and NAV is told the case and reason
(`vatExemption`, `vatOutOfScope` or `vatDomesticReverseCharge`). Lines with
different treatments can share an invoice, except AAM, which is the seller's
status and so covers every line.

An **alanyi adómentes seller** sets `SELLER_AAM=true` and sends lines with
`vatRate: 0` and no `vatExemption`; the server makes them AAM. A line with a
VAT rate is then refused.

What is refused with `422 VAT_INVALID`, with a message naming the line: a 0%
line without `vatExemption`, a `vatExemption` on a line with a rate, TAM
without a reason, AAM without `SELLER_AAM`, a rate with `SELLER_AAM`, and
reverse charge to a private buyer.

### How amounts are worked out

Per line: gross = `unitPriceGross × quantity`;
net = gross × 100 / (100 + rate), rounded to the forint (half away from zero);
VAT = gross − net. Totals are the sums of the lines. So a line's figures always
add up, and the invoice's totals are always the sum of its lines.

### Responses

`201` with `{ "alreadyIssued": false, "invoice": {…} }` for a
new invoice; `200` with `"alreadyIssued": true` for a repeated reference.

What happens next, without you doing anything: the invoice is reported to NAV
within seconds; once NAV accepts it, it is emailed. If NAV is down, the
checker keeps trying and alerts you after an hour.

## List invoices

`GET /v1/invoices?from=2026-11-01&to=2026-11-30&limit=50&offset=0`

| Parameter | |
|---|---|
| `from`, `to` | Issue dates, inclusive |
| `number` | One invoice number, e.g. `SZ2026/00001` |
| `reference` | Your reference |
| `limit` | 1–200, default 50 |
| `offset` | For paging |

Newest first. Returns `{ "total": 132, "invoices": [ … ] }`.

## Get one invoice

`GET /v1/invoices/{id}` → `{ "invoice": {…} }`

## Download the PDF

`GET /v1/invoices/{id}/pdf` → `application/pdf`, as an attachment named
`SZ2026-00001.pdf`.

The stored file is compared with the SHA-256 recorded when it was issued; if
they differ the PDF is not served (`500 PDF_CHANGED`) and an alert is raised.

## Reverse an invoice (storno)

`POST /v1/invoices/{id}/storno`

```json
{ "note": "A rendelést a vevő lemondta." }
```

The body is optional. Issues a new invoice with its own number that reverses
every line of the original, reports it to NAV as a STORNO, and emails it to
the original's buyer. An invoice can be reversed once; reversing it again
returns the same storno (`200`, `"alreadyIssued": true`). A storno cannot be
reversed (`422 ALREADY_STORNO`): issue a new invoice instead.

There is no partial correction (modifying invoice) in this version: reverse
the invoice and issue a correct one.

## Send the email again

`POST /v1/invoices/{id}/resend`

```json
{ "to": "masik.cim@example.com" }
```

`to` is optional; without it, the invoice's own address. Returns
`{ "outcome": "sent", "to": "…" }`. Recorded in the audit log.

## Look up a tax number

`GET /v1/taxpayers/{taxNumber}` with `12345678` or `12345678-2-41`.

```json
{
  "taxpayer": {
    "valid": true,
    "taxpayerId": "12345678",
    "name": "MINTA KORLÁTOLT FELELŐSSÉGŰ TÁRSASÁG",
    "shortName": "MINTA KFT.",
    "vatCode": "2",
    "countyCode": "41",
    "incorporation": "ORGANIZATION",
    "addresses": [{ "type": "HQ", "postalCode": "1011", "city": "BUDAPEST", "address": "FŐ UTCA 1." }]
  }
}
```

For filling in a company buyer's details in a form. `{ "valid": false }` when
NAV does not know the number. `503 NAV_UNAVAILABLE` when NAV does not answer.

## Tax inspection export

`GET /v1/exports/inspection?from=2026-01-01&to=2026-12-31`
or `?first=SZ2026/00001&last=SZ2026/00250`

A zip of every invoice in the range as NAV InvoiceData XML, the format
23/2014. (VI. 30.) NGM rendelet requires a program to produce for a tax
inspection. The `X-Invoice-Count` header says how many. Recorded in the audit
log. The same from the command line: `szamlazo export` ([operations.md](operations.md#tax-inspection-export)).

## Status

`GET /v1/status`

```json
{
  "environment": "production",
  "nav": "production",
  "email": "configured",
  "storage": "s3",
  "invoices": { "issued": 132, "awaitingNav": 0 },
  "emailsFailing": 0,
  "openAlerts": [],
  "jobs": [{ "name": "reconcile", "lastFinishedAt": "2026-11-02T02:03:11.000Z", "lastOutcome": "ok" }]
}
```

What a dashboard shows: anything not yet at NAV, failing emails, open alerts,
and when the nightly jobs last ran.

## Health

`GET /health`, no key needed: `200 {"status":"ok","database":"ok"}`, or `503`
when the database does not answer. For Docker's health check and load
balancers; it reveals nothing else.
