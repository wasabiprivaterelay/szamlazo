import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { startChecker } from "./checker.js";
import { createDatabase } from "./db/client.js";
import { migrate } from "./db/migrate.js";
import { ConfigError, readEnv, type Env } from "./env.js";
import { createApp, reportSoon } from "./http/app.js";
import { createLogger } from "./logger.js";
import { VERSION, servicesFromEnv } from "./services.js";

/**
 * The server: migrates the database, checks that invoices can be stored,
 * starts the HTTP API and the checker, and stops cleanly on SIGTERM, which is
 * how Docker stops a container.
 */

let env: Env;
try {
  env = readEnv();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    console.error("\nSee .env.example for what each variable means.");
    process.exit(78);
  }
  throw error;
}

const log = createLogger(env.LOG_LEVEL);
log.info({ version: VERSION, environment: env.ENVIRONMENT, nav: env.nav.configured ? env.nav.environment : "off" }, "starting");

await migrate(env.DATABASE_URL);
const { db, close } = createDatabase(env.DATABASE_URL);
const services = servicesFromEnv(env, db, log);

// An invoice that cannot be stored cannot be issued, so this is found out now
// rather than on the first invoice. A hiccup is tried three times.
for (let attempt = 1; ; attempt++) {
  try {
    await services.store.probe?.();
    break;
  } catch (error) {
    if (attempt === 3) {
      log.fatal({ err: error }, `the invoice storage (${env.STORAGE}) does not work; check the STORAGE settings`);
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
  }
}

const header = env.CLIENT_IP_HEADER?.toLowerCase();
const app = createApp(services, {
  // With a proxy in front (CLIENT_IP_HEADER=CF-Connecting-IP behind a
  // Cloudflare Tunnel), the proxy's header names the client. In a list such
  // as X-Forwarded-For only the last entry, added by the nearest proxy, is
  // trusted; the ones before it are whatever the client chose to send.
  clientIp: (context) =>
    (header ? context.req.header(header)?.split(",").at(-1)?.trim() || undefined : undefined) ??
    getConnInfo(context).remote.address ??
    "unknown",
  afterIssue: reportSoon(services),
});

const server = serve({ fetch: app.fetch, hostname: env.HOST, port: env.PORT }, (info) => {
  log.info({ host: env.HOST, port: info.port }, "listening");
});

if (env.API_KEYS.length === 0) {
  log.warn("API_KEYS is empty: every /v1 request is refused. Make a key with: npm run szamlazo -- api-key new <name>");
}
if (!env.nav.configured) log.warn("no NAV technical user: invoices are issued but not reported");
if (!services.checker.mailer) log.warn("no email service: invoices and alerts are not emailed");

const stopChecker = env.CHECKER_ENABLED
  ? startChecker(services.checker, { intervalMs: env.CHECKER_INTERVAL_SECONDS * 1000, heartbeatUrl: env.HEALTHCHECK_URL })
  : () => undefined;

let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, "stopping");
  stopChecker();
  server.close(() => {
    void close().then(() => process.exit(0));
  });
  // A request that hangs does not keep the container alive forever.
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
