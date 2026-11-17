# The web page

The server has a web page for people: the invoice list with search, a form
for a new invoice (with a preview that issues nothing), and each invoice with
its PDF, NAV and email status, resending and reversing. It is served at `/`
on its own hostname, behind its own Cloudflare Access application, for the
people named in `UI_USERS`.

## The rule: no API key in a browser

An API key is a machine's credential. Put it in browser code and anyone who
opens the page has it. The page therefore authenticates **people**, separately
from machines:

```
browser ──▶ Cloudflare Access ──▶ tunnel ──▶ server
            (login: an emailed       admin.example.hu: checks the
             one-time code)           Access JWT, takes the person's
                                      email as the actor
```

## Setting it up

1. **A second hostname**, `admin.example.hu`, on the same tunnel
   ([production.md](production.md#61-the-tunnel), add a public hostname, same
   service `server:3000`).
2. **A Cloudflare Access application** for it with an **Allow** policy (not
   Service Auth) that includes the named people's email addresses, logging in
   with a one-time PIN by email. Session duration: a working day. Three
   things in the dashboard that are easy to get wrong:
   - **Set up One-time PIN first.** Out of the box the team's only login
     method is "Cloudflare", which asks people for a Cloudflare account they
     don't have. Zero Trust → **Settings → Authentication** (newer
     dashboards: **Integrations → Identity providers**) → **Add new →
     One-time PIN**. It needs no settings.
   - **On the application**, in **Authentication**: turn **Accept all
     available identity providers** off, choose **One-time PIN** only, and
     turn **Apply instant authentication** on, so it goes straight to "enter
     your email".
   - **In the policy**, Include → selector **Emails**, then each address as
     its own entry. Not **Emails ending in**: `gmail.com` there would let in
     every Gmail user.
3. **Two values from the dashboard** go into `szamlazo.env`:
   - `ACCESS_TEAM_DOMAIN`: your team domain, `<team>.cloudflareaccess.com`
     (Zero Trust → **Settings → Custom pages**, or the address of any Access
     login page).
   - `ACCESS_AUD`: the new application's **Application Audience (AUD) Tag**,
     64 hexadecimal characters, on the application's **Overview** (older
     dashboards: **Basic information**).

   And who may use it, the same addresses as in the policy:
   `UI_USERS=anna@example.hu,bela@example.hu`. Then, from `deploy/`:
   `docker compose up -d` and `docker compose exec server node dist/cli.js doctor`.
4. Open `https://admin.example.hu/`, type your email, enter the code.

## How the server checks a person

Cloudflare adds a signed JWT to every request it lets through
(`Cf-Access-Jwt-Assertion`). The server checks its signature against
`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, its issuer, its
audience (`aud`) against `ACCESS_AUD`, and its expiry, and takes the email
from it, which must be on `UI_USERS` (a second allow-list in the server, so a
mistake in the Access policy alone does not open the door). Requests without
such a token get no page and no API, so even someone who reaches the server
another way gets nothing. The API hostname's own Access application has a
different AUD, so a token from there is never accepted as a person.

The email becomes the `actor` (`ui:anna@example.hu`) in the audit log and
in each invoice's `createdBy`, so the log says which person issued or
reversed an invoice.

For trying the page on your own computer, `ENVIRONMENT=development` with
`UI_DEV_USER=you@example.hu` treats every request as that person, with no
Access in front. The server refuses to start with it in any other
environment.

## Browser hardening

- `Content-Security-Policy: default-src 'none'; script-src 'nonce-…';
  style-src 'nonce-…'; connect-src 'self'; frame-src blob:;
  frame-ancestors 'none'; base-uri 'none'; form-action 'none'`, with a new
  nonce for every page load. The page is one file with no third-party
  scripts, fonts or analytics, and builds everything with `textContent`,
  never HTML, so nothing in an invoice can run.
- **CSRF:** every change the page makes (`POST`) carries the header
  `X-Szamlazo-UI: 1`. A form or script on another site cannot add it without
  the browser asking first, and the server refuses a person's `POST`
  without it.
- **No double issuing:** the new-invoice form sends a `reference` made when
  the form opens, so a double click or a retry after a lost answer returns
  the same invoice instead of issuing a second one.
- Issuing and reversing each ask for confirmation, stating that the invoice
  goes to NAV at once and can only be undone with a storno.

## What the page does

| Screen | API |
|---|---|
| **Invoices**: newest first, search by number or buyer, NAV and email status | `GET /v1/invoices?q=…` |
| **New invoice**: buyer (company or private), with "fill from NAV" for a tax number and a list of earlier buyers; lines; payment; email | `GET /v1/taxpayers/{n}`, `GET /v1/buyers`, `POST /v1/invoices` |
| **Preview**: the PDF exactly as it would be, marked "ELŐNÉZET – nem számla", with no number drawn and nothing stored or reported | `POST /v1/invoices/preview` |
| **Invoice**: the PDF, the totals, NAV status and messages, email status, its history; download, resend, "sent by hand", "new invoice from this one", storno | `GET /v1/invoices/{id}`, `…/pdf`, `…/history`, `…/resend`, `…/sent-manually`, `…/storno` |
| **Napló**: the activity log, filtered by person, event and date | `GET /v1/audit` |

The page and the API share one origin, so there is no CORS to configure.
`GET /v1/me` tells the page who is logged in and how the server is set up
(AAM, payment term, whether email and NAV are configured).

## The activity log

Everything is recorded in `audit_log`, a table the database refuses to
change or delete rows in (migration 0001), so the log cannot be tidied up
afterwards, not even by hand:

| Event | Who | Details |
|---|---|---|
| `login`, `login refused` | the person | address, country, browser, when the login expires; once per Access login |
| `invoice issued`, `storno issued` | person, API key or `cli` | number, buyer, total, email address, web page / API / command, address |
| `issue refused` | person or API key | why (`VAT_INVALID`, `INVALID_REQUEST`, …) |
| `inspection export` | person or API key | address, which invoices |
| `email resent`, `email sent manually` | person or API key | to whom, note |
| `nav sent`, `nav accepted`, `nav accepted with warnings`, `nav rejected`, `nav send failed` | `system` | transaction id, NAV's messages, attempt |
| `email sent`, `email failed`, `email bounced` | `system` | to whom, the provider's error |

The web page shows it under **Napló**, and each invoice shows its own part
under **Előzmények**. Machines read it with `GET /v1/audit` (filters `actor`,
`action`, `entity`, `from`, `to`, `limit`, `offset`) and
`GET /v1/invoices/{id}/history`.
