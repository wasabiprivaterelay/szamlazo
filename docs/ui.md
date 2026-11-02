# Building a UI

szamlazo is an API first. A UI is the natural next piece: a place for a
person to look up an invoice, issue one by hand, reverse one, resend an email
and see what needs attention. This is the recommended design, so that adding
it does not weaken anything the server already guarantees.

## The rule: no API key in a browser

An API key is a machine's credential. Put it in browser code and anyone who
opens the page has it. A UI therefore authenticates **people**, separately
from machines:

```
browser ──▶ Cloudflare Access ──▶ tunnel ──▶ server
            (login: your Google      admin.example.hu: checks the
             account or an emailed    Access JWT, takes the person's
             one-time code)           email as the actor
```

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
3. **The server verifies Access itself.** Cloudflare adds a signed JWT to
   every request it lets through (`Cf-Access-Jwt-Assertion`). The server checks
   its signature against
   `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, its audience
   (`aud`) against the application's AUD tag, and its expiry, and takes the
   email from it. Requests to the admin hostname without a valid JWT are
   refused, so even someone who reaches the server another way gets nothing.
   The email becomes the `actor` in the audit log, so the log says which
   person reversed an invoice, not just "admin".

   New settings for this: `ADMIN_HOST`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`,
   `ADMIN_EMAILS` (a second allow-list in the server, so a mistake in the
   Access policy alone does not open the door).

4. **Same origin.** The server serves the UI's static files on the admin
   hostname and the UI calls `/v1/…` there, so there is no CORS to configure
   and cookies never cross origins.

## Browser hardening

- `Content-Security-Policy: default-src 'self'; frame-ancestors 'none';
  base-uri 'none'; form-action 'self'`. No inline scripts, no third-party
  scripts, no fonts or analytics from elsewhere.
- **CSRF:** state-changing requests from the UI carry a custom header
  (`X-Requested-With: szamlazo`). A cross-site form cannot set one, and the
  server refuses `POST` on the admin host without it.
- Destructive actions (storno) need a confirmation that repeats the invoice
  number, and send the same `reference` on retry, so a double click cannot
  reverse twice (the API already guarantees once).

## Screens

| Screen | API |
|---|---|
| **Overview**: invoices waiting for NAV, failing emails, open alerts, last nightly runs | `GET /v1/status` |
| **Invoices**: search by number, reference, date range; newest first; paging | `GET /v1/invoices` |
| **Invoice**: every field, NAV status and messages, email status, PDF preview and download | `GET /v1/invoices/{id}`, `…/pdf` |
| **New invoice**: buyer (private or company), lines, payment; for a company, typing the tax number fills the name and address from NAV | `GET /v1/taxpayers/{n}`, `POST /v1/invoices` |
| **Reverse**: from an invoice, with a reason | `POST /v1/invoices/{id}/storno` |
| **Resend**: from an invoice, to its address or another | `POST /v1/invoices/{id}/resend` |
| **Export**: a date or number range, downloads the zip | `GET /v1/exports/inspection` |

The new-invoice form should compute line totals as the server does (gross ×
quantity; net = gross × 100 / (100 + rate), rounded half away from zero) to
show them while typing, but always display what the server returns as the
truth.

## Technology

Small and boring is right here: a handful of screens, a few users.

- **Vite + React + TypeScript**, with TanStack Query for requests. Or plain
  TypeScript with no framework; both are fine at this size.
- A new workspace package, `packages/admin`, built to static files that the
  server serves from the image. One deployment, one version.
- Types for requests and responses imported from `@szamlazo/server`'s zod
  schemas, so the UI and the API cannot drift apart.
- Hungarian interface text; English code.

Doing it this way changes nothing for the machine clients: the API, its keys
and the `szamlazo.example.hu` hostname stay exactly as they are.
