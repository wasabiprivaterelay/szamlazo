# Security

What szamlazo protects, against whom, how, and what is left for you. The last
section records the audit done for this release.

To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## What is worth protecting

1. **The invoice record.** Numbers that never skip or repeat, invoices that
   cannot be altered, and a NAV report for each. A mistake here is a tax
   problem, not a bug.
2. **The NAV technical user.** Whoever holds its keys can report invoices in
   your name.
3. **Buyers' personal data.** Names, addresses, emails, purchases: GDPR
   applies, and invoices must be kept for eight years.
4. **Availability.** A web shop that cannot invoice cannot sell; it should
   fail by retrying, never by losing or doubling an invoice.

## Who it defends against

- **The internet**: bots, scanners, credential stuffing. Nothing is exposed
  but SSH (keys only) and the tunnel, which only passes requests carrying a
  Cloudflare Access service token.
- **A leaked API key**: limited to what the API allows (issue, reverse, read),
  never alter or delete. It can be revoked alone.
- **A client bug**: retries, double clicks and duplicated messages do not
  double an invoice; malformed requests are refused, not repaired.
- **A partly compromised server**: the database refuses to change history,
  PDFs are fingerprinted, the tunnel token cannot touch DNS, the server's
  storage token cannot touch backups, and backups are encrypted with a key
  kept off the server.

Not defended against: someone with root on the server (they can do anything
the server can, including issue invoices), or with your NAV portal login.

## Controls

### Network

| Control | Where |
|---|---|
| Firewall: only SSH in | production.md 2.4 |
| SSH keys only, no root, fail2ban | production.md 2.3–2.4 |
| No published ports except on 127.0.0.1 (Docker bypasses ufw) | `deploy/compose.yml` |
| Database on an internal network with no route out | `deploy/compose.yml` (`internal: true`) |
| HTTPS terminated by Cloudflare; tunnel is outbound only | production.md 6.1 |
| Cloudflare Access: service token required before the server sees a request | production.md 6.2 |

### The API

| Control | Detail |
|---|---|
| API keys | 32 random bytes (`szk_` + base64url). Only the SHA-256 is configured; a key cannot be recovered from the config, a log or a backup. Compared in constant time against every configured key. |
| Brute force | 20 wrong keys per client address per 10 minutes, then `429`. Correct keys are never locked out. |
| Rate limit | 600 requests a minute per key. |
| Input | Every body is validated by a strict schema: unknown fields refused, lengths and ranges bounded, control characters refused, dates checked to exist. Bodies over 256 KB refused before parsing. |
| Output | JSON only; one error shape; internal errors say nothing about internals. PDFs and exports `Content-Disposition: attachment`. |
| Headers | `Cache-Control: no-store` everywhere; `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, HSTS, same-origin resource policy. |
| Ids | Invoice ids are UUIDs, checked before any lookup; storage paths are built from the invoice number by a fixed pattern and checked to stay inside the storage folder. |
| Client address | Only from `CLIENT_IP_HEADER` when set, and from a list only the last entry (added by the nearest proxy). |

### Data integrity

| Control | Detail |
|---|---|
| Gapless numbering | One counter row, locked and incremented in the same transaction that stores the invoice. A failed issue gives the number back. Tested with concurrent requests. |
| Append-only | Database triggers reject `UPDATE` and `DELETE` on invoices and on the audit log, whoever asks. |
| Database checks | Totals must add up; a storno must point at an invoice; one storno per invoice; one invoice per reference. |
| Idempotency | `reference` plus a fingerprint of the request; concurrent duplicates serialised by an advisory lock. |
| PDF fingerprint | SHA-256 stored at issue; checked before serving and nightly. |
| NAV reconcile | Nightly, both directions: everything we reported is at NAV, and nothing with our prefix is at NAV that we did not issue. |
| Audit log | Who (API key name) issued, reversed, resent and exported what, and when. |

### NAV

| Control | Detail |
|---|---|
| Live and test kept apart | Only `ENVIRONMENT=production` may use NAV's live system, and production must. Checked at start-up. |
| Seller matches technical user | Start-up fails if the seller's tax number and the NAV user's differ. |
| Request signing | SHA-512 password hash, SHA3-512 request signature, AES-128 token decryption as the specification requires; request ids random. |
| XML | Built by escaping, never by string templates; characters XML cannot hold are refused rather than sent. |
| Responses | Timeout 30 s; gzip bodies capped at 64 MB decompressed; parsed without external entities. |
| No duplicate reports | Before resending, NAV is asked whether it already has the invoice. |

### Secrets

| Secret | Kept in | Can do |
|---|---|---|
| NAV password and keys | `deploy/szamlazo.env` (mode 600) | Report invoices for your taxpayer |
| API keys | Clients only; the server holds hashes | Use the API |
| Brevo key | `szamlazo.env` | Send email from your domain |
| R2 server token | `szamlazo.env` | Read/write the PDF bucket only |
| R2 backup token | `deploy/backup.env` | Read/write the backup bucket only |
| Restic password | `deploy/restic-password` **and your password manager** | Read backups |
| Tunnel token | `deploy/.env`, not given to the server | Run this one tunnel |
| Access service tokens | Clients only | Pass Cloudflare Access |
| Postgres password | `deploy/.env` | The database, from inside Docker's network only |

Logs redact authorization headers and every key, password and secret field;
the server never logs buyers' details. No secret is ever printed by a command
except `api-key new`, which prints the new key once.

### Container

The server runs as the unprivileged `node` user, on a read-only root file
system (only the invoice volume and `/tmp` are writable), with every Linux
capability dropped, `no-new-privileges`, and memory and process limits. The
image holds production dependencies only, installed with `--ignore-scripts`.

### Supply chain

- `package-lock.json` pins every dependency; CI installs with `npm ci`.
- `npm audit` is part of CI and fails on moderate or worse.
- Dependabot opens weekly updates for npm and monthly for GitHub Actions and
  Docker images.
- Ten runtime dependencies besides the two internal packages, all widely
  used and pure JavaScript (no native modules): `hono`, `@hono/node-server`,
  `drizzle-orm`, `postgres`, `zod`, `pino`, `pdfmake`, `fast-xml-parser`,
  `aws4fetch`, `fflate`.
- CI runs with read-only repository permissions and does not keep its
  checkout credentials.

## What is left to you

- **One API key per client**, and revoke a client's key when it goes. Keys are
  not scoped: any key can issue and reverse invoices.
- **Who can reach the server.** Use Cloudflare Access (or keep the server on
  127.0.0.1). Do not expose it with an API key as the only lock.
- **Root on the server** is everything. Keep SSH keys-only, the OS updated,
  and the `docker` group to yourself.
- **Your NAV portal login.** Whoever has it can create technical users.
- **Backups**: run the restore drill. Keep the restic password off the server.
- **A UI** you build is a new way in: follow [ui.md](ui.md).
- **GDPR.** You are the controller. Invoices are kept for eight years by law
  (Számv. tv. 169. §), which is the basis for keeping buyers' data that long;
  mention it in your privacy notice. Brevo, Cloudflare and your VPS provider
  are processors: sign their DPAs (they offer them in their dashboards) and
  keep data in the EU (R2 EU jurisdiction, an EU VPS).

## Audit of this release (0.1.0)

Done before the first public release: a review of every route, the NAV
client, storage, the checker, configuration, the Docker image and the
deployment files, plus dependency and secret scans.

**Results of the checks**

| Check | Result |
|---|---|
| `npm audit` (production and development dependencies) | 0 vulnerabilities |
| Secrets or personal data in the repository | None found (pattern scan for keys, tokens, private keys, tax numbers) |
| Unauthenticated access to `/v1` | `401`; after 20 attempts `429` |
| Bodies: malformed JSON, 300 KB, unknown fields, `__proto__` | `400`, `413`, `400`, `400` |
| Path traversal through invoice ids | `404` (ids must be UUIDs) |
| Altering or deleting an invoice in SQL | Refused by trigger (test: `numbering.test.ts`) |
| Concurrent issue of the same reference | One invoice (test) |
| Configuration mixing test and live NAV | Server refuses to start (test: `config.test.ts`) |

**Found and fixed**

| Finding | Severity | Fix |
|---|---|---|
| Development tools pulled in `minimatch` with a ReDoS and an old `esbuild` whose dev server allowed cross-origin reads | Low (development machines only) | npm `overrides` to fixed versions; `npm audit` clean |
| Rate limiter: under a flood of distinct client addresses, memory and per-request sweep cost grew with the flood | Medium (availability) | Hard cap; oldest entries dropped; test added |
| With `CLIENT_IP_HEADER=X-Forwarded-For`, a client could pick its own address and dodge the brute-force limit | Medium | Only the last entry of a list is trusted; docs recommend `CF-Connecting-IP` |
| A gzip response from NAV was decompressed without a size limit | Low (NAV is trusted, over TLS) | 64 MB cap |
| Characters XML cannot carry (control characters, lone surrogates) would have produced XML NAV rejects | Low (an alert, not data loss) | Refused at the API with a clear error; refused again when building XML |
| NAV request ids were derived from the time alone | Low | Random suffix from the OS's CSPRNG |
| Missing settings were reported as "expected string, received undefined" | Usability | "not set" |

**Accepted, by design**

- `resend` may email an invoice to any address the caller gives. It is meant
  for correcting a wrong address; it is recorded in the audit log.
- Rate limits live in memory, per process. Right for one server; a restart
  forgets counts, which can only ever let a client through, not lock it out.
- A tax inspection export is built in memory. Fine for a year of a small
  business's invoices (thousands); split the range for more.
