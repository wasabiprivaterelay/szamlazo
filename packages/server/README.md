# @szamlazo/server

The szamlazo server: the HTTP API, Postgres, PDF storage, email, and the
checker that reports to NAV, retries, alerts, reconciles and archives. It
puts [`@szamlazo/invoicing`](../invoicing) and [`@szamlazo/nav`](../nav)
together into a running service.

It is not published as a library; it runs from this repository or as the
Docker image built by the repository's `Dockerfile`. Start with the
[README](../../README.md).

| | |
|---|---|
| Configuration | [`.env.example`](../../.env.example) |
| API | [docs/api.md](../../docs/api.md) |
| Running it | [docs/production.md](../../docs/production.md), [docs/operations.md](../../docs/operations.md) |

## Layout

```
src/
  index.ts          start-up: configuration, migrations, storage probe, HTTP, checker, shutdown
  cli.ts            maintenance commands (api-key, migrate, doctor, status, export, …)
  env.ts            every setting, validated at start-up
  services.ts       wires configuration into the parts below
  http/             the API (Hono), API keys, rate limits
  invoices.ts       issuing and reversing: validation, idempotency, numbering, storage
  nav-reporting.ts  an invoice to NAV and back
  checker.ts        the background loop: report, email, alert, reconcile, archive, heartbeat
  tax-export.ts     the tax inspection export
  storage.ts        PDFs in a folder or an S3 bucket
  email.ts          Brevo
  db/               schema (Drizzle), the numbering sequence, migrations runner
migrations/         SQL, applied at start-up; 0001 adds the append-only triggers
tests/              against a real Postgres, with NAV and email faked
```

## Commands

```sh
npm run dev                          # from the repository root: the server, reloading
npm test -w @szamlazo/server         # needs `docker compose up -d`
npm run db:generate -w @szamlazo/server   # after changing src/db/schema.ts
npm run szamlazo -- help             # the maintenance commands
```
