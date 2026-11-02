# Connecting NAV's test system

NAV runs a complete copy of Online Számla for testing:
[onlineszamla-test.nav.gov.hu](https://onlineszamla-test.nav.gov.hu/). Invoices
reported there have no legal effect, so you can send as many as you like. Do
this before production: it proves your technical user, your keys and the whole
round trip work, and it is where to try anything new.

The test and live systems are separate. Each has its own registration, its own
technical user and its own keys; keys from one do not work on the other.

You need about twenty minutes, and:

- **A KAÜ login**: Ügyfélkapu+ or the DÁP mobile app. Plain Ügyfélkapu
  (username and password only) is no longer accepted.
- **The right to act for the taxpayer** you will invoice as: you are its
  legal representative, the sole trader yourself, or have a permanent
  authorisation (állandó meghatalmazás) for it at NAV.
- **The quick start done** (the server runs on your computer; see the
  [README](../README.md)).

## 1. Register as the primary user

1. Open [onlineszamla-test.nav.gov.hu](https://onlineszamla-test.nav.gov.hu/)
   and choose **Belépés** (Login).
2. Under **Elsődleges felhasználó** (primary user), choose
   **Bejelentkezés KAÜ-vel** and identify yourself with Ügyfélkapu+ or DÁP.
3. Give your email address and phone number, accept the privacy notice, and
   save.
4. If you can act for several taxpayers, pick the one you will invoice as.
5. Check the taxpayer's details NAV pre-filled, add a contact email and phone,
   and save.

## 2. Create a technical user

The technical user is the login this server uses. It can report and query
invoices and nothing else; it cannot log in to the portal.

1. Top menu: **Felhasználók** (Users) → **Új felhasználó** (New user).
2. Choose **Technikai felhasználó** → **Létrehozás**.
3. Set a password. Use a long random one, for example from
   `openssl rand -base64 24`, and keep it in your password manager.
4. Permissions: tick **Számlák kezelése** (manage invoices) and
   **Számlák lekérdezése** (query invoices). Nothing else is needed. Save.
5. Choose **Kulcsgenerálás** (generate keys). NAV shows the
   **XML aláírókulcs** (signing key) and **XML cserekulcs** (exchange key).

Copy four values, plus the tax number:

| NAV portal | `.env` |
|---|---|
| Technical user's login (felhasználónév) | `NAV_LOGIN` |
| The password you set | `NAV_PASSWORD` |
| XML aláírókulcs | `NAV_SIGNING_KEY` |
| XML cserekulcs (16 characters) | `NAV_EXCHANGE_KEY` |
| The taxpayer's tax number | `NAV_TAX_NUMBER` |

Generating keys again later makes the old ones stop working at once, so do it
only when you mean to replace them everywhere.

## 3. Configure

In `.env` (from the quick start):

```sh
NAV_ENVIRONMENT=test
NAV_LOGIN=abcdef123456
NAV_PASSWORD=…
NAV_SIGNING_KEY=…
NAV_EXCHANGE_KEY=…
NAV_TAX_NUMBER=12345678

# Who runs this installation, for NAV's records (sent with every request).
NAV_SOFTWARE_DEV_NAME=Minta Kft.
NAV_SOFTWARE_DEV_CONTACT=it@example.hu
```

Then set the **seller** to the taxpayer you registered: `SELLER_NAME`,
address, and `SELLER_TAX_NUMBER` with the full 11 digits. The server refuses
to start when the seller's tax number and `NAV_TAX_NUMBER` belong to different
taxpayers, because NAV would reject every invoice.

Keep `ENVIRONMENT=development` (or `staging`). The server refuses to combine
a non-production installation with NAV's live system, and the other way round.

## 4. Check the technical user

```sh
npm run nav -- check
```

```
NAV test system

token exchange   ok (token valid until 2026-11-02T12:05:00.000Z)
taxpayer lookup  ok: MINTA KFT. (12345678-2-41)

The technical user, the signing key and the exchange key all work.
```

If it fails, the message says which value is wrong; see
[Common NAV errors](#common-nav-errors) below.

## 5. Send a test invoice

Two ways, both against the test system only.

**The NAV package alone**, without the server or a database. It sends a
made-up invoice, waits for NAV's verdict, and with `--storno` reverses it too:

```sh
npm run nav -- test-invoice --storno
```

```
sending TESZT1793620800123 …
transaction 4A1B…
  waiting for NAV (PROCESSING)
invoice 1: DONE

NAV accepted TESZT1793620800123.

sending TESZT1793620805123S …
…
NAV accepted TESZT1793620805123S.
```

(The exact numbers and transaction ids differ on every run.)

**Through the server**, the way a real invoice goes: numbered, stored, PDF
rendered, reported, followed up.

```sh
npm run szamlazo -- test-invoice
npm run szamlazo -- test-invoice --email you@example.com   # also emails it, if Brevo is set up
```

```
issued SZ2026/00002: gross 13040 Ft, PDF at invoices/2026/SZ2026-00002.pdf
reporting it to NAV's test system …
NAV: accepted
```

Then look at it from NAV's side:

```sh
npm run nav -- invoice SZ2026/00002             # the XML NAV stored
npm run nav -- digest 2026-11-01 2026-11-30     # everything NAV has for a period
npm run nav -- taxpayer 12345678                # what NAV knows about a tax number
```

It also shows on the portal: **Számlák** → **Kibocsátott számlák** (issued
invoices).

Invoices issued through the API while `npm run dev` runs are reported the same
way, within seconds. `GET /v1/invoices/<id>` shows `"nav": { "status": "done" }`
once NAV has accepted one.

## What to test before going live

Each of these is one request against the test system; together they cover
what production will do.

| Try | Expect |
|---|---|
| A private buyer, card payment | NAV `DONE`; email sent after acceptance |
| A company buyer with a real tax number | NAV `DONE`; buyer's name checked against NAV first |
| A company buyer with a made-up tax number | `422 TAXPAYER_INVALID`, nothing issued |
| Transfer payment | Due date `PAYMENT_TERM_DAYS` ahead; bank account on the PDF |
| Mixed 5 % and 27 % lines | One VAT summary row per rate on the PDF and at NAV |
| A TAM line (`vatRate: 0`, `vatExemption: { "case": "TAM", "reason": "Áfa tv. 85. § (1) e)" }`) and, if they apply to you, AAM or reverse charge | NAV `DONE`; the reason printed under the totals |
| `POST /v1/invoices/<id>/storno` | A new number, negative amounts, NAV `DONE` as a STORNO |
| The same `reference` twice | Second answer `200` with `"alreadyIssued": true` |
| Stop your network, issue, wait, restore | The checker reports it once you are back; no duplicate |
| `npm run szamlazo -- reconcile` | No alerts: NAV's records and yours agree |

## Common NAV errors

| NAV says | Means | Fix |
|---|---|---|
| `INVALID_SECURITY_USER` | Login, password or tax number wrong, or the user belongs to the other system | Check `NAV_LOGIN`, `NAV_PASSWORD`, `NAV_TAX_NUMBER`; test keys only work on test |
| `INVALID_REQUEST_SIGNATURE` | The signing key is wrong | Copy `NAV_SIGNING_KEY` again, with no spaces around it |
| `the NAV credentials are not usable: the exchange key is not 16 bytes`, or the token cannot be decrypted | The exchange key is wrong | Copy `NAV_EXCHANGE_KEY` again |
| `INVALID_USER_RELATION` | The technical user is not linked to this taxpayer | Create the user while acting for the right taxpayer |
| `NOT_REGISTERED_CUSTOMER` | The taxpayer has not finished registering | Finish step 1 |
| `ABORTED`, saying the invoice number already exists | That number was reported before | On the test system, numbers left over from an earlier database; use another `INVOICE_PREFIX` while testing |
| `ABORTED` with any other code | NAV rejected the content | The alert email and `GET /v1/invoices/<id>` show NAV's message; open an issue with it |
| `OPERATION_FAILED`, timeouts, 5xx | NAV is down or overloaded | Nothing; the checker retries, and alerts after an hour |

NAV publishes planned maintenance on the
[Online Számla news page](https://onlineszamla.nav.gov.hu/) and the test
system is sometimes down when the live one is not.

## Then: production

The live system at [onlineszamla.nav.gov.hu](https://onlineszamla.nav.gov.hu/)
works the same way: register there, create a **new** technical user with new
keys, and put those in the production configuration with
`NAV_ENVIRONMENT=production`. [production.md](production.md) step 7.
