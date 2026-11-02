# Production

From an empty server to real invoices reported to NAV. Follow the steps in
order; each ends with a check, and the next step assumes it passed. Plan an
afternoon for the first time.

What you end up with:

```
                    Cloudflare (DNS, TLS, Access)
                               ▲
                               │ outbound tunnel only; no open ports
┌──────────────────────────────┴───────────────────────────────┐
│ VPS (Ubuntu 24.04, Docker)                                    │
│   cloudflared ──▶ server :3000 ──▶ postgres (no network out)  │
└──────────────┬───────────────────────┬───────────────────────┘
               │                       │
   NAV, Brevo, Healthchecks.io    Cloudflare R2: invoice PDFs,
                                  encrypted nightly backups
```

- The server is reachable only through Cloudflare, and only by clients holding
  a Cloudflare Access service token **and** an API key.
- The firewall lets in SSH and nothing else.
- PDFs and backups live off the server, in R2; backups are encrypted before
  they leave.
- You get an email when NAV rejects an invoice, when anything is stuck for an
  hour, when the nightly comparison with NAV finds a difference, when the
  server stops, and when a backup does not run.

Commands starting with `$` run on your own computer; everything else runs on
the server.

**Running costs**, at the time of writing: a 2 GB VPS (about €5 a month at
Hetzner or similar); Cloudflare, R2 (10 GB free), Brevo (300 emails a day
free) and Healthchecks.io (20 checks free) all fit their free plans for a
small business.

## Contents

1. [Before you start](#1-before-you-start)
2. [The server](#2-the-server)
3. [The code](#3-the-code)
4. [Cloudflare R2: storage for PDFs and backups](#4-cloudflare-r2-storage-for-pdfs-and-backups)
5. [Brevo: email](#5-brevo-email)
6. [Cloudflare Tunnel and Access](#6-cloudflare-tunnel-and-access)
7. [NAV: the live technical user](#7-nav-the-live-technical-user)
8. [Configuration](#8-configuration)
9. [Start](#9-start)
10. [Monitoring: Healthchecks.io](#10-monitoring-healthchecksio)
11. [Backups](#11-backups)
12. [Connecting your web shop](#12-connecting-your-web-shop)
13. [Go-live checklist](#13-go-live-checklist)
14. [Updating](#14-updating)

## 1. Before you start

You need:

- **A domain whose DNS is on Cloudflare** (free plan is enough). If the
  domain's DNS is elsewhere, Cloudflare's "Add a site" moves it; your website
  and mailboxes can stay where they are, only the nameservers change.
- **A VPS** with Ubuntu 24.04 LTS, 2 GB RAM, 20 GB disk, in the EU, and your
  SSH key on it.
- **Accounts** at [Brevo](https://www.brevo.com/) and
  [Healthchecks.io](https://healthchecks.io/).
- **A KAÜ login** (Ügyfélkapu+ or DÁP) and the right to act for the taxpayer.
- **The NAV test system done.** [nav-test-environment.md](nav-test-environment.md)
  proves your setup before anything is real.
- **A password manager.** Several secrets below are generated once and must be
  kept; one of them (the backup password) is the only way to read your
  backups.

## 2. The server

A fresh VPS is attacked by bots within minutes. These steps make it accept
SSH keys only, close every port but SSH, and update itself. If you already
run hardened servers, skim the checklist at the end of this step and move on.

**Keep the provider's web console open in a browser tab.** Two steps change
how you log in; if one goes wrong, the console is the way back. **Test every
SSH change in a new terminal before closing the old one.**

### 2.1 Updates, clock, swap

```sh
$ ssh root@<server ip>
apt update && apt full-upgrade -y
timedatectl set-timezone UTC
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
[ -f /var/run/reboot-required ] && reboot
```

UTC because the database stores UTC and the server converts to Budapest time
itself. Swap because a 2 GB server building a Docker image beside Postgres
can briefly run out of memory.

### 2.2 A user for everyday work

```sh
adduser deploy                      # asks for a password: sudo will ask for it
usermod -aG sudo deploy
mkdir -p /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys
```

**In a new terminal:** `ssh deploy@<server ip>`, then `sudo whoami` prints
`root`. Only then continue, as `deploy`.

### 2.3 SSH: keys only, no root

```sh
sudo tee /etc/ssh/sshd_config.d/10-hardening.conf > /dev/null <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AllowUsers deploy
MaxAuthTries 3
EOF
sudo sshd -t && sudo sshd -T | grep -Ei '^(permitrootlogin|passwordauthentication|allowusers)'
```

Expect `permitrootlogin no`, `passwordauthentication no`, `allowusers deploy`.
The `10-` prefix matters: SSH keeps the first value it reads, and cloud
images ship a later file that often turns passwords back on. Then:

```sh
sudo systemctl restart ssh
```

**In a new terminal:** `ssh deploy@<server ip>` works; `ssh root@<server ip>`
is refused with `Permission denied (publickey)`.

### 2.4 Firewall and fail2ban

Allow SSH **before** enabling the firewall, or you cut yourself off.

```sh
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw enable

sudo apt install -y fail2ban python3-systemd
sudo tee /etc/fail2ban/jail.local > /dev/null <<'EOF'
[DEFAULT]
bantime = 1h
findtime = 10m
maxretry = 5
bantime.increment = true

[sshd]
enabled = true
backend = systemd
EOF
sudo systemctl enable --now fail2ban
```

No web port is opened, now or later: the Cloudflare Tunnel connects out.
**Docker bypasses ufw** for published ports, which is why
`deploy/compose.yml` publishes nothing except on `127.0.0.1`. Keep it that
way if you edit it.

### 2.5 Automatic security updates

```sh
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades          # answer Yes
sudo tee /etc/apt/apt.conf.d/52-reboot > /dev/null <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "03:30";
EOF
```

Every container restarts on its own after a reboot. Invoices requested during
the minute it takes are retried by the client (step 12) or simply wait.

### 2.6 Docker

From Docker's own repository, which is current, unlike Ubuntu's:

```sh
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin git
sudo usermod -aG docker deploy
```

Log out and in again, then `docker run --rm hello-world`.

### Checklist

```sh
sudo sshd -T | grep -E '^(permitrootlogin|passwordauthentication)'   # both no
sudo ufw status                                                      # active, only OpenSSH
sudo fail2ban-client status sshd                                     # jail running
systemctl is-enabled unattended-upgrades                             # enabled
free -h | grep Swap                                                  # 2.0Gi
docker compose version                                               # a version
```

## 3. The code

```sh
cd ~
git clone https://github.com/wasabiprivaterelay/szamlazo.git
cd szamlazo
git checkout v0.1.0            # a release tag, not main, in production
```

Everything below happens in `~/szamlazo/deploy`.

## 4. Cloudflare R2: storage for PDFs and backups

Two buckets: one for the invoice PDFs, which the server reads and writes, and
one for the encrypted backups, which only the backup script touches. Separate
buckets and separate tokens mean the server can never touch the backups.

In the Cloudflare dashboard → **R2 Object Storage**:

1. **Create bucket** `szamlazo-invoices`. Location: **Specify jurisdiction →
   European Union**. Invoices are personal data; this keeps them in the EU.
2. **Create bucket** `szamlazo-backups`, also in the EU jurisdiction.
3. **Manage API tokens → Create API token**:
   - Name `szamlazo-server`, permission **Object Read & Write**, **Apply to
     specific buckets only** → `szamlazo-invoices`. Create, and copy the
     **Access Key ID**, **Secret Access Key**, and the **EU** S3 endpoint
     (`https://<account id>.eu.r2.cloudflarestorage.com`). They are shown once.
   - Again: `szamlazo-backup`, **Object Read & Write**, only
     `szamlazo-backups`. Copy its keys too.

Optional, recommended: on `szamlazo-invoices` → **Settings → Bucket lock
rules**, add a rule retaining every object for 8 years. Then not even a
leaked token can delete an invoice before the law lets you. Add it after the
first successful invoice, so test files are not locked in.

Check: nothing to check yet; `doctor` in step 9 writes and reads a probe file.

## 5. Brevo: email

Every Brevo setting below is under the **account dropdown** in the top right
corner of the Brevo dashboard.

**5.1 Authenticate your domain.** Without this, invoice emails land in spam.

1. Account dropdown → **Settings → Senders, Domains, IPs → Domains → Add a
   domain**. Enter the part after the `@` of your sender address
   (`example.hu`), then **Add domain**.
2. Choose **Authenticate the domain yourself**. Brevo lists three kinds of
   DNS record: a **Brevo code** (TXT), **DKIM** (two CNAME records, or one TXT
   on older accounts) and **DMARC** (TXT).
3. In Cloudflare → your domain → **DNS → Records**, add each record exactly as
   Brevo shows it. Two Cloudflare traps:
   - For the DKIM **CNAME** records, switch **Proxy status** off (grey cloud,
     "DNS only"). Proxied, DKIM fails.
   - If you already have a DMARC record (`_dmarc`), edit it instead of adding
     a second one.
4. Back in Brevo, click **Authenticate this email domain**. It usually works
   within minutes; DNS can take up to 48 hours.

**5.2 The sender.** Account dropdown → **Settings → Senders, Domains, IPs →
Senders → Add sender**: for example `szamla@example.hu`, with your business
name. This address is `EMAIL_FROM` in step 8.

**5.3 The API key.** Account dropdown → **SMTP & API → API keys** tab →
**Generate a new API key**, name `szamlazo`, **Generate**. Copy it now
(it starts `xkeysib-`); Brevo shows it once. It is `BREVO_API_KEY` in step 8.

**5.4 Authorise the server's addresses.** Brevo blocks API calls from IP
addresses it does not know. For the first 30 days it learns and allows new
ones, then blocking switches on, and a server that later changes address
(or one Brevo never saw) has every email refused. So list the server
explicitly. On the server:

```sh
curl -4 -s https://ifconfig.me; echo      # the IPv4 address
curl -6 -s https://ifconfig.me; echo      # the IPv6 address, if it has one
```

Then account dropdown → **Settings → Security → Authorized IPs → Authorize
IP address**: choose **IPv4**, paste the address, **Authorize IP address**.
Repeat with **IPv6** if the second command printed one. When Brevo blocks
an address it emails the account owner, naming the address and the key.

Brevo's free plan sends 300 emails a day, which is 300 invoices a day minus
alerts. A larger shop needs a paid plan.

## 6. Cloudflare Tunnel and Access

The tunnel is an outbound connection from the server to Cloudflare, which
carries requests for `szamlazo.example.hu` back down. No port opens. Access
then lets through only clients holding a service token, before a request ever
reaches the server.

> If the only client is a web shop **on the same server**, you can skip this
> step: leave `COMPOSE_PROFILES` empty in step 8 and let the shop call
> `http://127.0.0.1:3000`. Every other case: do it.

### 6.1 The tunnel

Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create a tunnel**:

1. Type **Cloudflared**, name `szamlazo`, **Save tunnel**.
2. On the install page, choose **Docker**. Copy only the long token after
   `--token` in the command shown. Do not run the command; Compose runs
   cloudflared. The token goes in `deploy/.env` in step 8.
3. **Next**. Add a public hostname (in newer dashboards: **Published
   application routes**): subdomain `szamlazo`, your domain, service type
   **HTTP**, URL `server:3000`. Save.

The token can run this one tunnel and nothing else; it cannot change your DNS.

### 6.2 Access: only your clients get through

Zero Trust → **Access → Service credentials → Service Tokens → Create
Service Token**: name `webshop`, duration **Non-expiring** (or a year, with a
calendar reminder). Copy the **Client ID** and **Client Secret**; the secret is
shown once. Make one per client.

Zero Trust → **Access → Applications → Add an application → Self-hosted**:

1. Name `szamlazo`, domain `szamlazo.example.hu`, no path.
2. Policy: name `clients`, action **Service Auth**, include **Service Token** →
   `webshop` (and any others).
3. Save.

Check, from your computer:

```sh
$ curl -s -o /dev/null -w '%{http_code}\n' https://szamlazo.example.hu/health
```

`403` from Cloudflare, before the server is even running. That is Access doing
its job. With the token it will be `200` once step 9 is done:

```sh
$ curl -s https://szamlazo.example.hu/health \
    -H "CF-Access-Client-Id: <client id>" -H "CF-Access-Client-Secret: <client secret>"
```

## 7. NAV: the live technical user

The same as on the test system ([nav-test-environment.md](nav-test-environment.md)
steps 1 and 2), but at **[onlineszamla.nav.gov.hu](https://onlineszamla.nav.gov.hu/)**:
register as primary user, create a new technical user with **Számlák
kezelése** and **Számlák lekérdezése**, generate its keys. Keep the five
values for step 8. Do not reuse the test user's; it does not work here.

## 8. Configuration

Two files, both on the server only, both readable by you alone.

**`deploy/.env`** is for Docker Compose: the database password and the
tunnel token.

```sh
cd ~/szamlazo/deploy
cp .env.example .env && chmod 600 .env
sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 32)/" .env
nano .env                       # paste TUNNEL_TOKEN from step 6.1
```

**`deploy/szamlazo.env`** is for the server, from the repository's
`.env.example`, which explains every line:

```sh
cp ../.env.example szamlazo.env && chmod 600 szamlazo.env
nano szamlazo.env
```

Set, at least:

```sh
ENVIRONMENT=production
# DATABASE_URL: delete this line; compose.yml builds it from POSTGRES_PASSWORD.
CLIENT_IP_HEADER=CF-Connecting-IP

SELLER_NAME=…                    # your business, exactly as registered
SELLER_POSTCODE=…
SELLER_CITY=…
SELLER_ADDRESS=…
SELLER_TAX_NUMBER=…              # all 11 digits
SELLER_REGISTRATION_NUMBER=…
SELLER_BANK_ACCOUNT=…
SELLER_AAM=false                 # true only if you are alanyi adómentes (AAM)
INVOICE_PREFIX=…                 # final: do not change after the first invoice

NAV_ENVIRONMENT=production
NAV_LOGIN=…                      # step 7
NAV_PASSWORD=…
NAV_SIGNING_KEY=…
NAV_EXCHANGE_KEY=…
NAV_TAX_NUMBER=…
NAV_SOFTWARE_DEV_NAME=…
NAV_SOFTWARE_DEV_CONTACT=…

STORAGE=s3
S3_ENDPOINT=https://<account id>.eu.r2.cloudflarestorage.com
S3_BUCKET=szamlazo-invoices
S3_ACCESS_KEY_ID=…               # the szamlazo-server token, step 4
S3_SECRET_ACCESS_KEY=…

BREVO_API_KEY=…                  # step 5
EMAIL_FROM=szamla@example.hu
EMAIL_FROM_NAME=…
ALERT_EMAIL=…                    # you
INVOICE_ARCHIVE_EMAIL=…          # your accountant, or an archive mailbox

HEALTHCHECK_URL=…                # step 10; leave empty until then
```

A logo: copy it to `deploy/branding/logo.png` and set
`INVOICE_LOGO_PATH=/app/branding/logo.png`.

**API keys.** One per client, so each can be revoked on its own and the audit
log shows who issued what:

```sh
docker compose run --rm --no-deps server node dist/cli.js api-key new webshop
```

Give the printed `szk_…` key to the web shop's configuration; it is shown
only this once. Put the printed `webshop:…` line in `szamlazo.env` as
`API_KEYS` (comma-separate several).

## 9. Start

```sh
cd ~/szamlazo/deploy
docker compose up -d --build
docker compose ps                        # postgres healthy, server healthy, cloudflared running
docker compose logs server | tail -20    # "listening", no warnings about NAV or email
```

The first build takes a few minutes. If the server keeps restarting, its log
names every setting that is wrong.

Then the full check:

```sh
docker compose exec server node dist/cli.js doctor
```

```
szamlazo 0.1.0, ENVIRONMENT=production

  ok   configuration  every variable is valid
  ok   seller         Minta Kft., 12345678-2-41, prefix SZ
  ok   database       reachable, schema up to date
  ok   storage        bucket szamlazo-invoices writable and readable
  ok   NAV            production system: technical user works; NAV knows you as MINTA KFT.
  ok   email          Brevo, from szamla@example.hu
  ok   alerts         to you@example.hu
  ok   heartbeat      pinged after every checker pass
  ok   API keys       1 configured

Everything that is configured works.
```

Every line must be `ok` before going on. And from your computer, through
Cloudflare (step 6.2's command): `{"status":"ok","database":"ok"}`.

## 10. Monitoring: Healthchecks.io

The server emails you about everything it notices. Healthchecks.io covers
what it cannot notice: itself being down.

In Healthchecks.io, **Add Check** twice:

| Check | Period | Grace | URL goes to |
|---|---|---|---|
| `szamlazo checker` | 5 minutes | 30 minutes | `HEALTHCHECK_URL` in `szamlazo.env` |
| `szamlazo backup` | 1 day | 2 hours | `BACKUP_HEALTHCHECK_URL` in `backup.env` (step 11) |

The server pings after every checker pass, and pings `/fail` when a pass
fails. If the server stops, hangs, loses its database or the VPS goes away,
the pings stop and Healthchecks emails you. Add your phone in Healthchecks'
integrations if you want a push notification as well.

After setting `HEALTHCHECK_URL`: `docker compose up -d` (it restarts the
server with the new setting). The check turns green within five minutes.

## 11. Backups

Every night `deploy/bin/backup` dumps the database and copies the invoice
folder, encrypts both with [restic](https://restic.net/), and stores them in
`szamlazo-backups`. Kept: 30 daily, 12 monthly and 10 yearly copies.

```sh
cd ~/szamlazo/deploy
cp backup.env.example backup.env && chmod 600 backup.env
nano backup.env                        # the szamlazo-backup token (step 4), the backup check URL (step 10)
openssl rand -base64 32 > restic-password && chmod 600 restic-password
cat restic-password                    # → into your password manager, now
bin/backup init                        # creates the encrypted repository, once
bin/backup                             # the first backup
bin/backup snapshots                   # lists it
```

**The restic password is the one secret that must exist off the server.**
Without it, the backups cannot be read by anyone, including you. Keep a
second copy offline.

Every night at 02:15 UTC:

```sh
crontab -e
```

```
15 2 * * * $HOME/szamlazo/deploy/bin/backup >> $HOME/szamlazo-backup.log 2>&1
```

**Prove the backup restores**, now and every six months
([operations.md](operations.md#restore-drill) has the full drill):

```sh
bin/backup dump --tag database latest /szamlazo.dump | wc -c      # the size of the dump, read back from R2
```

## 12. Connecting your web shop

Every request needs three headers: the two Access headers from step 6.2 and
the API key from step 8.

```sh
curl https://szamlazo.example.hu/v1/invoices \
  -H "CF-Access-Client-Id: $SZAMLAZO_ACCESS_ID" \
  -H "CF-Access-Client-Secret: $SZAMLAZO_ACCESS_SECRET" \
  -H "Authorization: Bearer $SZAMLAZO_KEY" \
  -H "Content-Type: application/json" \
  -d @invoice.json
```

How a client should behave, so that no order is ever invoiced twice or not at
all:

1. **Always send `reference`**: your order id. A repeated request with the
   same reference returns the invoice already issued (`200`,
   `"alreadyIssued": true`).
2. **Retry on timeouts, `429`, `5xx` and connection errors**, with the same
   body, after 1, 5, 30 seconds. Because of (1), a retry is always safe.
3. **Do not retry `400`, `409` or `422`**: the request itself is wrong; log it
   and show it to a person.
4. **Store the returned `id` and `invoiceNumber`** with the order. Link the
   customer to the PDF through your own backend, never by handing out the
   API key.

[api.md](api.md) has every field and error.

## 13. Go-live checklist

- [ ] The NAV test system round trip worked
      ([nav-test-environment.md](nav-test-environment.md), "What to test").
- [ ] `doctor` shows `ok` on every line, with `ENVIRONMENT=production` and
      `NAV_ENVIRONMENT=production`.
- [ ] `/health` through Cloudflare: `403` without the Access headers, `200`
      with them; `/v1/status` `401` without the API key.
- [ ] Nothing listens publicly: from your computer,
      `nmap -Pn <server ip>` shows only `22/tcp open`.
- [ ] Both Healthchecks are green.
- [ ] `bin/backup snapshots` lists a backup; the restic password is in your
      password manager **and** offline.
- [ ] The invoice email arrived in a real inbox, not in spam (send one to
      yourself with the first real invoice, or `resend` it to yourself).
- [ ] **Your accountant has seen a sample PDF** and agreed with it: seller
      details, numbering, VAT, wording.
- [ ] `INVOICE_PREFIX` is final.
- [ ] Optional: the R2 bucket lock rule is on `szamlazo-invoices`.

Then issue the first real invoice, and watch it in `GET /v1/invoices/<id>`
until `nav.status` is `done` and `email.status` is `sent`.

## 14. Updating

```sh
cd ~/szamlazo
git fetch --tags
git checkout v0.2.0                     # the new release; read its release notes first
cd deploy
bin/backup                              # a backup from just before
docker compose up -d --build
docker compose exec server node dist/cli.js doctor
```

The server applies database migrations itself at start-up. Migrations only
ever add; none rewrite or delete an issued invoice. To go back, check out the
previous tag and build again; if the new version had migrated the database,
restore the backup taken just before ([operations.md](operations.md#restoring-for-real)).

Docker images (Postgres, cloudflared) are pinned in `compose.yml` and updated
with the repository, not on their own. The OS updates itself (step 2.5).
