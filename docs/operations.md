# Operations

Running szamlazo once it is live. Day to day there is nothing to do: the
checker reports, retries, emails and compares on its own, and emails you only
when a person is needed.

Commands below run on the server in `~/szamlazo/deploy`. `szamlazo` is short
for:

```sh
docker compose exec server node dist/cli.js
```

(Add it to `~/.bashrc` as `alias szamlazo='docker compose -f ~/szamlazo/deploy/compose.yml exec server node dist/cli.js'`.)
On a development checkout the same commands are `npm run szamlazo -- …`.

## Contents

- [What runs on its own](#what-runs-on-its-own)
- [Looking at the state](#looking-at-the-state)
- [Alerts and what to do](#alerts-and-what-to-do)
- [Correcting an invoice](#correcting-an-invoice)
- [Tax inspection export](#tax-inspection-export)
- [Monthly archive](#monthly-archive)
- [Changing seller details](#changing-seller-details)
- [Rotating secrets](#rotating-secrets)
- [Restore drill](#restore-drill)
- [Restoring for real](#restoring-for-real)

## What runs on its own

| When | What | Configured by |
|---|---|---|
| Seconds after an invoice is issued | Reports it to NAV and, once accepted, emails it | — |
| Every 5 minutes | The checker: follows every invoice not yet accepted, retries failed emails, notices bounces, raises and resolves alerts, pings Healthchecks.io | `CHECKER_INTERVAL_SECONDS`, `HEALTHCHECK_URL` |
| Nightly after 03:00 (Budapest) | Compares the last 7 days with NAV's records, both ways; re-checks every stored PDF's SHA-256 | — |
| First night of each month | Emails last month's invoices (PDFs and NAV XML, zipped) | `INVOICE_ARCHIVE_EMAIL` |
| Nightly, 02:15 UTC | Encrypted backup to R2 | cron, `deploy/bin/backup` |
| Nightly, 03:30 UTC if needed | OS security updates and reboot | unattended-upgrades |

Retries: NAV reports after 5, 15, 45 and then every 60 minutes; emails after
5, 15, 45 and then every 60 minutes. Before resending a report, the checker
asks NAV whether it already has the invoice, so an answer lost on the way
never turns into a duplicate. Only one checker pass runs at a time, even with
several server processes (a Postgres advisory lock).

## Looking at the state

```sh
szamlazo status                 # invoices not yet at NAV, failing emails, open alerts, last job runs
docker compose ps               # containers and their health
docker compose logs -f server   # JSON logs; secrets redacted, no buyer details
```

`GET /v1/status` returns the same as `status`, for a dashboard.

## Alerts and what to do

Alerts go to `ALERT_EMAIL`, once when raised and once when resolved. Open
alerts are in `status`. Most resolve themselves; this is what each means.

**`SZ2026/00042: not at NAV after an hour`**
NAV has been unreachable or slow for an hour. Usually NAV maintenance or an
outage; the checker keeps trying and the alert resolves itself when NAV
accepts the invoice. If it lasts more than a day, check that the server can
reach the internet and that `szamlazo doctor` passes. The law's deadline for
reporting is not missed because NAV was down, but keep the alert emails as
evidence.

**`SZ2026/00042: NAV rejected it`**
NAV refused the invoice's data (status `ABORTED`); the alert includes NAV's
messages. This needs a person, and it means one of two things: data this
version does not handle (see [limits.md](limits.md)), or a bug. The invoice
was issued (it has a number and a PDF) but is not reported, and it must be. Do
not reverse it: a storno of an unreported invoice is rejected too. Talk to
your accountant; the report can be completed on the NAV portal by hand. Then
open an issue with NAV's message (without personal data) so it is fixed for
everyone.

**`SZ2026/00042: email not sent for an hour`**
Brevo refused the email or the buyer's mailbox bounced it. If *every*
email fails, the usual cause is Brevo blocking the server's IP address: Brevo
emails the account owner when it does, and the fix is in
[production.md, step 5.4](production.md#5-brevo-email). Otherwise check the
email's entry in Brevo's transactional logs. For a wrong address, send it to the right one:

```sh
curl -X POST https://szamlazo.example.hu/v1/invoices/<id>/resend \
  -H "Authorization: Bearer …" -H "Content-Type: application/json" \
  -d '{"to":"correct@example.com"}'
```

**`SZ2026/00042: missing from NAV's list`**
Our records say NAV accepted the invoice, but NAV's own list for the period
does not include it. Rare; check on the NAV portal (**Számlák → Kibocsátott
számlák**). If it is there, the alert resolves on the next night. If not, the
invoice needs reporting again: contact your accountant and open an issue.

**`SZ2026/00099: at NAV but not issued here`**
NAV holds an invoice with your prefix that this server did not issue. Another
program is reporting with the same prefix, or someone recorded it on the NAV
portal by hand. Find out who; two programs must never share a numbering
series. (Invoices with other prefixes, from other programs, are ignored.)

<a id="pdf-changed"></a>**`SZ2026/00042: stored PDF changed`**
The stored PDF no longer matches the SHA-256 taken when it was issued. It is
not served until fixed. Someone or something altered or replaced the file.
Treat it as a security incident: find out how, then restore the original
from a backup (STORAGE=local) or from your monthly archive email. The check
passes again once the bytes match.

**Healthchecks.io: `szamlazo checker is DOWN`**
The server stopped pinging: it is down, hung, or the VPS is unreachable.
`docker compose ps`, `docker compose logs --tail 100 server`, and if needed
`docker compose up -d`. Invoices requested meanwhile were refused, not lost;
clients retry (production.md, step 12).

**Healthchecks.io: `szamlazo backup is DOWN`**
The nightly backup did not finish. `tail -50 ~/szamlazo-backup.log`. Run
`bin/backup` by hand once fixed.

## Correcting an invoice

An issued invoice cannot be changed or deleted, by the API or in the
database (a trigger refuses). To correct one:

1. Reverse it: `POST /v1/invoices/<id>/storno` (optionally with a `note`
   saying why). This issues a storno invoice with its own number, reports it
   to NAV and emails it.
2. Issue the correct invoice as new. Use a new `reference` (e.g.
   `order-1001-2`), because the old one belongs to the reversed invoice.

## Tax inspection export

A tax inspector may ask for the invoices of a period in electronic form
(23/2014. (VI. 30.) NGM rendelet). This produces exactly that: a zip of the
invoices as NAV InvoiceData XML.

```sh
docker compose exec -T server node dist/cli.js export 2026-01-01 2026-12-31 > szamlak-2026.zip
docker compose exec -T server node dist/cli.js export SZ2026/00001 SZ2026/00250 > szamlak.zip
```

`-T` matters: without it the zip is mangled by the terminal. Or through the
API: `GET /v1/exports/inspection?from=…&to=…`. Every export is recorded in
the audit log.

## Monthly archive

On the first night of each month the previous month's invoices are emailed to
`INVOICE_ARCHIVE_EMAIL` as one zip: every PDF, plus a zip of their NAV XML.
A large month is split over several emails. To send a month again, or one
from before the address was set:

```sh
szamlazo send-archive 2026-10
```

## Changing seller details

Moved office, new bank account, new name: change the `SELLER_…` lines in
`deploy/szamlazo.env` and `docker compose up -d`. New invoices carry the new
details; issued ones keep what was true when they were issued (each invoice
stores a copy of the seller). A new tax number means a new taxpayer: that is a
new installation, with its own NAV technical user.

## Rotating secrets

Rotate a secret when someone who knew it leaves, when it may have leaked, and
otherwise yearly. After any change to `szamlazo.env`: `docker compose up -d`.

**An API key**, without downtime:

1. `szamlazo api-key new webshop-2026` and add the new `name:hash` to
   `API_KEYS`, keeping the old one: `API_KEYS=webshop:…,webshop-2026:…`.
   `docker compose up -d`.
2. Switch the client to the new key.
3. Remove the old entry from `API_KEYS`; `docker compose up -d`.

**NAV keys.** Generating new keys on the NAV portal disables the old ones at
once. Update `NAV_SIGNING_KEY` and `NAV_EXCHANGE_KEY` (and `NAV_PASSWORD` if
changed) straight after, and restart. Invoices issued in between just wait;
nothing is lost. `szamlazo doctor` confirms.

**Brevo, R2, Cloudflare Access tokens**: create the new one, put it in place,
restart (or update the client), check, then delete the old one in the
provider's dashboard.

**The database password**: `docker compose exec postgres psql -U szamlazo -c "alter user szamlazo password '<new hex>'"`,
then set the same in `deploy/.env` and `docker compose up -d`.

**The restic password**: `bin/backup key add`, then `bin/backup key list`
and `bin/backup key remove <old id>`; update `deploy/restic-password` and
your password manager.

## Restore drill

A backup that has never been restored is not a backup. Every six months, and
after any change to how the database is set up:

```sh
cd ~/szamlazo/deploy
docker run -d --name restore-drill -e POSTGRES_USER=szamlazo -e POSTGRES_DB=szamlazo \
  -e POSTGRES_PASSWORD=drill postgres:17-alpine
sleep 5
bin/backup dump --tag database latest /szamlazo.dump \
  | docker exec -i restore-drill pg_restore -U szamlazo -d szamlazo --no-owner --exit-on-error
docker exec restore-drill psql -U szamlazo -tc "select count(*), max(invoice_number) from invoices"
szamlazo status | head -12
docker rm -f restore-drill
```

The count and the last number from the drill must match production as of the
backup's time. With `STORAGE=local`, also check the PDFs:
`bin/backup ls --tag invoices latest | tail`.

## Restoring for real

The server is gone, or the database is damaged.

1. A new server, set up with [production.md](production.md) steps 2 and 3.
2. Put back `deploy/.env`, `deploy/szamlazo.env`, `deploy/backup.env` and
   `deploy/restic-password` (from your password manager; new R2 tokens if the
   old ones may have been on the lost server).
3. Start only the database: `docker compose up -d postgres`.
4. Restore it (use a snapshot id from `bin/backup snapshots` instead of
   `latest` to go further back):

   ```sh
   bin/backup dump --tag database latest /szamlazo.dump \
     | docker compose exec -T postgres pg_restore -U szamlazo -d szamlazo --no-owner --exit-on-error
   ```

5. With `STORAGE=local`, restore the PDFs into the server's volume:

   ```sh
   bin/backup restore-invoices            # or: bin/backup restore-invoices <snapshot id>
   ```

   With `STORAGE=s3` the PDFs never left R2 and there is nothing to do.

6. **Before any client can reach the server**, compare with NAV. Invoices
   issued after the backup was taken exist at NAV and with your customers,
   but not in the restored database, and the counter would hand their
   numbers out again. Start with the tunnel off (`COMPOSE_PROFILES=` in
   `deploy/.env`), then:

   ```sh
   docker compose up -d
   szamlazo reconcile
   szamlazo status
   ```

   Every "at NAV but not issued here" alert is one such invoice. If there are
   any, move the counter past the highest of them (57 here), so no number is
   used twice:

   ```sh
   docker compose exec postgres psql -U szamlazo -c "update invoice_sequence set last_number = 57 where id = 1"
   ```

   Ask your accountant how to record the invoices that exist only at NAV
   (their PDFs are in your monthly archive email or the buyers' inboxes).

7. Turn the tunnel back on (`COMPOSE_PROFILES=tunnel`), `docker compose up -d`,
   and `szamlazo doctor`.
