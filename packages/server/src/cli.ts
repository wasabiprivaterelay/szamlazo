/**
 * Maintenance commands, run beside the server:
 *
 *   npm run szamlazo -- <command>                       (from a checkout)
 *   docker compose run --rm server node dist/cli.js <command>   (in production)
 *
 * Nothing here prints a secret, except `api-key new`, which prints the new
 * key once because that is its whole purpose.
 */
import { createDatabase } from "./db/client.js";
import { migrate } from "./db/migrate.js";
import { ConfigError, readEnv, type Env } from "./env.js";
import { newApiKey } from "./http/auth.js";
import { createLogger } from "./logger.js";
import { advanceInvoice, monthlyArchive, reconcile, runChecks } from "./checker.js";
import { issue } from "./invoices.js";
import { VERSION, servicesFromEnv } from "./services.js";
import { exportInvoices } from "./tax-export.js";

const USAGE = `usage: szamlazo <command>

  api-key new <name>           make an API key; prints the key once and the line for API_KEYS
  migrate                      bring the database schema up to date
  doctor                       check every setting: database, storage, NAV, email
  test-invoice [--email <a>]   issue a sample invoice and follow it through NAV (not in production)
  status                       what is waiting: invoices not yet at NAV, failing emails, alerts
  checks                       run one checker pass now
  reconcile                    run the nightly comparison with NAV now
  export <from> <to>           tax inspection export (dates or invoice numbers) to stdout: > szamlak.zip
  send-archive <yyyy-mm>       email a month's invoices to INVOICE_ARCHIVE_EMAIL now`;

const [command, ...rest] = process.argv.slice(2);

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

function loadEnv(): Env {
  try {
    return readEnv();
  } catch (error) {
    if (error instanceof ConfigError) fail(`${error.message}\n\nSee .env.example for what each variable means.`, 78);
    throw error;
  }
}

async function main() {
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return;
  }

  if (command === "api-key") {
    const [action, name] = rest;
    if (action !== "new" || !name || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(name)) {
      fail("usage: api-key new <name>   (name: lowercase letters, digits, - and _, e.g. webshop)", 64);
    }
    const { key, hash } = newApiKey();
    console.log(`API key for "${name}" (shown once; store it in the client's secrets):\n\n  ${key}\n`);
    console.log(`Add this to API_KEYS in the server's env file (comma-separate several):\n\n  ${name}:${hash}\n`);
    return;
  }

  const env = loadEnv();
  // Logs go to standard error, so `export … > file.zip` gets only the zip.
  const log = createLogger(env.LOG_LEVEL === "info" ? "warn" : env.LOG_LEVEL, process.stderr);

  if (command === "migrate") {
    await migrate(env.DATABASE_URL);
    console.error("the database schema is up to date");
    return;
  }

  await migrate(env.DATABASE_URL);
  const { db, close } = createDatabase(env.DATABASE_URL, { max: 3 });
  const services = servicesFromEnv(env, db, log);
  try {
    switch (command) {
      case "doctor":
        await doctor(env, services);
        return;

      case "test-invoice": {
        if (env.ENVIRONMENT === "production") fail("test-invoice does not run in production: it would issue a real invoice", 64);
        const emailIndex = rest.indexOf("--email");
        const email = emailIndex >= 0 ? rest[emailIndex + 1] : undefined;
        const { invoice } = await issue(
          db,
          services.store,
          services.settings,
          {
            buyer: { type: "private", name: "Teszt Vevő", postcode: "1011", city: "Budapest", address: "Teszt utca 1.", email },
            lines: [
              { description: "Teszt tétel", quantity: 2, unit: "db", unitPriceGross: 1270, vatRate: 27 },
              { description: "Teszt szolgáltatás", quantity: 1, unit: "óra", unitPriceGross: 10500, vatRate: 5 },
            ],
            paymentMethod: "transfer",
            sendEmail: Boolean(email),
            note: "Tesztszámla, nem valódi ügylet.",
          },
          { actor: "cli" },
        );
        console.log(`issued ${invoice.invoiceNumber}: gross ${invoice.totalGross} Ft, PDF at ${invoice.pdfPath}`);
        if (!services.nav) {
          console.log("no NAV technical user is configured, so it is not reported. Set the NAV_ variables to try that too.");
          return;
        }
        console.log(`reporting it to NAV's ${env.nav.environment} system …`);
        const progress = await advanceInvoice({ ...services.checker, navPollIntervalMs: 3000 }, invoice.id);
        console.log(`NAV: ${progress.nav}${progress.email ? `, email: ${progress.email}` : ""}`);
        if (progress.nav !== "accepted") console.log("the checker keeps following it; see `status` in a few minutes.");
        return;
      }

      case "status":
        console.log(JSON.stringify(await statusOf(services), null, 2));
        return;

      case "checks":
        await runChecks(services.checker);
        console.error("checker pass done; see `status`");
        return;

      case "reconcile":
        await reconcile(services.checker);
        console.error("nightly comparison done; see `status` for any alerts it raised");
        return;

      case "export": {
        const [from, to] = rest;
        const isDate = (value?: string) => /^\d{4}-\d{2}-\d{2}$/.test(value ?? "");
        if (!from || !to || isDate(from) !== isDate(to)) {
          fail("give two dates (2026-01-01 2026-12-31) or two invoice numbers (SZ2026/00001 SZ2026/00250)", 64);
        }
        if (process.stdout.isTTY) fail("the zip would be printed on the screen; redirect it: … export 2026-01-01 2026-12-31 > szamlak.zip", 64);
        const { zip, invoiceNumbers } = await exportInvoices(
          db,
          isDate(from) ? { issuedFrom: from, issuedTo: to } : { firstNumber: from, lastNumber: to },
        );
        process.stdout.write(zip);
        console.error(`${invoiceNumbers.length} invoice(s): ${invoiceNumbers[0] ?? "-"} to ${invoiceNumbers.at(-1) ?? "-"}`);
        return;
      }

      case "send-archive": {
        const [month] = rest;
        if (!month || !/^\d{4}-\d{2}$/.test(month)) fail("give a month: send-archive 2026-09", 64);
        if (!env.INVOICE_ARCHIVE_EMAIL) fail("set INVOICE_ARCHIVE_EMAIL first", 64);
        const sent = await monthlyArchive(services.checker, month, env.INVOICE_ARCHIVE_EMAIL);
        console.error(`${sent} invoice(s) of ${month} sent to ${env.INVOICE_ARCHIVE_EMAIL}`);
        return;
      }

      default:
        fail(`unknown command: ${command}\n\n${USAGE}`, 64);
    }
  } finally {
    await close();
  }
}

async function statusOf(services: ReturnType<typeof servicesFromEnv>) {
  const { db, env } = services;
  const { sql } = await import("drizzle-orm");
  const [counts] = await db.execute<{ issued: number; awaiting_nav: number; emails_failing: number }>(sql`
    select
      (select count(*)::int from invoices) as issued,
      (select count(*)::int from invoices i where not exists (
        select 1 from nav_submissions s where s.invoice_id = i.id and s.status in ('done', 'warning'))) as awaiting_nav,
      (select count(*)::int from email_log where status in ('failed', 'bounced')) as emails_failing`);
  const open = await db.execute<{ subject: string; raised_at: string }>(
    sql`select subject, raised_at from alerts where resolved_at is null order by raised_at`,
  );
  const jobs = await db.execute<{ name: string; last_finished_at: string; last_outcome: string }>(
    sql`select name, last_finished_at, last_outcome from job_runs order by name`,
  );
  return {
    version: VERSION,
    environment: env.ENVIRONMENT,
    nav: services.nav ? env.nav.environment : "not configured",
    email: services.checker.mailer ? "configured" : "not configured",
    invoices: counts,
    openAlerts: [...open],
    jobs: [...jobs],
  };
}

async function doctor(env: Env, services: ReturnType<typeof servicesFromEnv>) {
  const { sql } = await import("drizzle-orm");
  let healthy = true;
  const line = (ok: boolean | "skip", what: string, detail: string) => {
    if (ok === false) healthy = false;
    console.log(`${ok === "skip" ? "  -  " : ok ? "  ok " : " FAIL"}  ${what.padEnd(14)} ${detail}`);
  };

  console.log(`szamlazo ${VERSION}, ENVIRONMENT=${env.ENVIRONMENT}\n`);
  line(true, "configuration", "every variable is valid");
  line(true, "seller", `${env.SELLER_NAME}, ${env.SELLER_TAX_NUMBER}, prefix ${env.INVOICE_PREFIX}`);

  try {
    await services.db.execute(sql`select 1`);
    line(true, "database", "reachable, schema up to date");
  } catch (error) {
    line(false, "database", error instanceof Error ? error.message : String(error));
  }

  try {
    await services.store.probe?.();
    line(true, "storage", env.STORAGE === "s3" ? `bucket ${env.S3_BUCKET} writable and readable` : `folder ${env.STORAGE_DIR} writable and readable`);
  } catch (error) {
    line(false, "storage", error instanceof Error ? error.message : String(error));
  }

  if (services.nav) {
    try {
      await services.nav.tokenExchange();
      const own = await services.nav.queryTaxpayer(env.SELLER_TAX_NUMBER);
      line(
        own.valid,
        "NAV",
        own.valid
          ? `${env.nav.environment} system: technical user works; NAV knows you as ${own.name}`
          : `${env.nav.environment} system: the technical user works, but NAV does not know ${env.SELLER_TAX_NUMBER} as valid`,
      );
    } catch (error) {
      line(false, "NAV", error instanceof Error ? error.message : String(error));
    }
  } else {
    line(env.ENVIRONMENT === "production" ? false : "skip", "NAV", "no technical user configured; invoices are not reported");
  }

  line(services.checker.mailer ? true : "skip", "email", services.checker.mailer ? `Brevo, from ${env.EMAIL_FROM}` : "not configured; nothing is emailed");
  line(env.ALERT_EMAIL ? true : "skip", "alerts", env.ALERT_EMAIL ? `to ${env.ALERT_EMAIL}` : "ALERT_EMAIL not set; problems only show in /v1/status");
  line(env.HEALTHCHECK_URL ? true : "skip", "heartbeat", env.HEALTHCHECK_URL ? "pinged after every checker pass" : "HEALTHCHECK_URL not set");
  line(env.API_KEYS.length > 0 ? true : env.ENVIRONMENT === "production" ? false : "skip", "API keys", `${env.API_KEYS.length} configured`);

  console.log(healthy ? "\nEverything that is configured works." : "\nFix the FAIL lines above.");
  if (!healthy) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
