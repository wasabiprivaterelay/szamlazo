import { and, asc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { zipSync } from "fflate";
import type { Logger } from "pino";
import type { NavClient } from "@szamlazo/nav";
import { parseInvoiceNumber, type NumberFormat, type Party } from "@szamlazo/invoicing";
import type { Database } from "./db/client.js";
import { alerts, emailLog, invoices, jobRuns, navSubmissions } from "./db/schema.js";
import { budapestDate, budapestHour, monthBounds, previousMonth } from "./dates.js";
import type { Attachment, Mailer } from "./email.js";
import { alertEmail, alertResolvedEmail, archiveEmail, invoiceEmail } from "./messages.js";
import { advanceReport } from "./nav-reporting.js";
import { sha256Of, type InvoiceStore } from "./storage.js";
import { exportInvoices } from "./tax-export.js";

/**
 * What has to happen after an invoice is issued, and the checker that makes
 * sure it did: reported to NAV, accepted by NAV, emailed to the buyer. Each
 * step leaves a row behind (nav_submissions, email_log), so what is unfinished
 * is a question for the database, not for anyone's memory. The checker asks
 * it every few minutes and takes each unfinished thing one step further.
 * Every step is safe to repeat: NAV is asked before anything is sent twice,
 * and an email is sent once per dedupe key.
 *
 * What the checker cannot settle becomes an alert: one email to ALERT_EMAIL,
 * and another when it is gone.
 */

export type CheckerDeps = {
  db: Database;
  store: InvoiceStore;
  /** Absent without NAV credentials: nothing is reported. */
  nav?: NavClient;
  /** Absent without an email service: nothing is sent. */
  mailer?: Mailer;
  /** Emails the provider could not deliver, by message id. */
  undelivered?: () => Promise<readonly { messageId: string; event: string; reason?: string }[]>;
  numberFormat: NumberFormat;
  /** Not production: every email says it is a test. */
  isTest: boolean;
  production: boolean;
  alertTo?: string;
  archiveTo?: string;
  log: Pick<Logger, "info" | "warn" | "error">;
  now?: () => Date;
  /** How long to wait between asking NAV for its verdict; shortened in tests. */
  navPollIntervalMs?: number;
};

const HOUR = 60 * 60_000;
/** Something stuck for this long is worth a person's attention. */
const PATIENCE = HOUR;

type Problem = { key: string; subject: string; body: string };

export type SendOutcome = "sent" | "done" | "waiting" | "failed" | "no mailer" | "no recipient";

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Minutes to wait before sending a failed email again: 5, 15, 45, then hourly. */
function emailRetryMinutes(attempts: number): number {
  return [5, 15, 45][attempts - 1] ?? 60;
}

/**
 * Sends the email a key stands for, once. Whoever inserts the key's row is
 * the one who sends; a failed send is tried again after a pause, and one cut
 * off halfway — the process died between the provider and the database —
 * after a quarter of an hour, on the view that an email twice is better
 * than not at all.
 */
async function sendOnce(
  deps: CheckerDeps,
  entry: { key: string; template: string; to: string; invoiceId?: string },
  build: () => Promise<{ subject: string; text: string; attachments?: readonly Attachment[] }>,
): Promise<SendOutcome> {
  const { db, mailer } = deps;
  if (!mailer) return "no mailer";
  const now = deps.now?.() ?? new Date();

  let [row] = await db
    .insert(emailLog)
    .values({
      recipient: entry.to,
      template: entry.template,
      invoiceId: entry.invoiceId,
      dedupeKey: entry.key,
      status: "sending",
      attemptCount: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: emailLog.dedupeKey })
    .returning();

  if (!row) {
    const [existing] = await db.select().from(emailLog).where(eq(emailLog.dedupeKey, entry.key));
    if (!existing || !["failed", "sending"].includes(existing.status)) return "done";
    const wait = existing.status === "failed" ? emailRetryMinutes(existing.attemptCount) * 60_000 : 15 * 60_000;
    if (now.getTime() - existing.updatedAt.getTime() < wait) return "waiting";
    [row] = await db
      .update(emailLog)
      .set({ status: "sending", attemptCount: existing.attemptCount + 1, updatedAt: now })
      .where(and(eq(emailLog.id, existing.id), eq(emailLog.updatedAt, existing.updatedAt)))
      .returning();
    // Someone else claimed it in between.
    if (!row) return "waiting";
  }

  try {
    const { messageId } = await mailer({ to: entry.to, ...(await build()) });
    await db
      .update(emailLog)
      .set({ status: "sent", providerMessageId: messageId, sentAt: now, lastError: null, updatedAt: now })
      .where(eq(emailLog.id, row.id));
    return "sent";
  } catch (error) {
    await db
      .update(emailLog)
      .set({ status: "failed", lastError: describe(error).slice(0, 1000), updatedAt: now })
      .where(eq(emailLog.id, row.id));
    deps.log.warn({ email: row.id, template: entry.template }, "email not sent");
    return "failed";
  }
}

/**
 * The invoice, emailed to its buyer once. `copy` makes a further copy at a
 * person's request: its own key, so it goes once however often the button is
 * pressed, and optionally to a corrected address.
 */
export async function sendInvoiceEmail(
  deps: CheckerDeps,
  invoiceId: string,
  options: { copy?: string; to?: string } = {},
): Promise<SendOutcome> {
  const [invoice] = await deps.db.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!invoice) throw new Error(`no invoice with id ${invoiceId}`);
  const to = options.to ?? invoice.emailTo;
  if (!to) return "no recipient";

  return sendOnce(
    deps,
    {
      key: options.copy ? `invoice:${invoice.id}:copy:${options.copy}` : `invoice:${invoice.id}`,
      template: `invoice-${invoice.type}`,
      to,
      invoiceId: invoice.id,
    },
    async () => {
      let reverses: string | undefined;
      if (invoice.originalInvoiceId) {
        const [original] = await deps.db.select().from(invoices).where(eq(invoices.id, invoice.originalInvoiceId));
        reverses = original?.invoiceNumber;
      }
      const pdf = await deps.store.get(invoice.pdfPath);
      // What is attached is what was issued: the stored file, checked against
      // the fingerprint taken when it was made.
      if (sha256Of(pdf) !== invoice.pdfSha256) {
        throw new Error(`the stored PDF of ${invoice.invoiceNumber} does not match its fingerprint`);
      }
      return {
        ...invoiceEmail(
          {
            invoiceNumber: invoice.invoiceNumber,
            type: invoice.type,
            totalGross: invoice.totalGross,
            currency: invoice.currency,
            paymentMethod: invoice.paymentMethod,
            dueDate: invoice.dueDate,
            buyer: invoice.buyerSnapshot as Party,
            seller: invoice.sellerSnapshot as Party,
            reverses,
          },
          deps.isTest,
        ),
        attachments: [{ name: `${invoice.invoiceNumber.replaceAll("/", "-")}.pdf`, content: pdf }],
      };
    },
  );
}

export type InvoiceProgress = { nav?: string; email?: SendOutcome };

/**
 * Everything due for one invoice, as far as it will go now: reported, and
 * once NAV has accepted it, emailed. A buyer gets an invoice NAV has
 * accepted; one NAV refuses has something wrong with it and is corrected
 * before anyone sees it.
 */
export async function advanceInvoice(deps: CheckerDeps, invoiceId: string): Promise<InvoiceProgress> {
  const progress: InvoiceProgress = {};
  let accepted = true;
  if (deps.nav) {
    const state = await advanceReport(deps.db, deps.nav, invoiceId, {
      now: deps.now?.(),
      pollIntervalMs: deps.navPollIntervalMs,
    });
    progress.nav = state.state;
    accepted = state.state === "accepted";
  } else if (deps.production) {
    // Production always has NAV (the configuration insists), so this is a
    // development or staging install without a technical user.
    accepted = false;
  }
  if (accepted) progress.email = await sendInvoiceEmail(deps, invoiceId);
  return progress;
}

/**
 * One pass of the checker. Each part runs whatever the others did, so a NAV
 * outage does not stop emails and a mail outage does not stop reporting; a
 * failure is logged and becomes an alert if it lasts.
 */
export async function runChecks(deps: CheckerDeps): Promise<void> {
  const { db, log } = deps;
  const now = deps.now?.() ?? new Date();
  const problems: Problem[] = [];

  // Invoices NAV has not accepted yet.
  const unreported = await db
    .select()
    .from(invoices)
    .where(
      sql`not exists (select 1 from ${navSubmissions} where ${navSubmissions.invoiceId} = ${invoices.id} and ${navSubmissions.status} in ('done', 'warning'))`,
    )
    .orderBy(asc(invoices.createdAt));

  for (const invoice of unreported) {
    if (!deps.nav) break;
    const waited = now.getTime() - invoice.createdAt.getTime();
    try {
      const state = await advanceReport(db, deps.nav, invoice.id, { now, pollIntervalMs: deps.navPollIntervalMs });
      if (state.state === "rejected") {
        problems.push({
          key: `nav-rejected:${invoice.id}`,
          subject: `${invoice.invoiceNumber}: NAV rejected it`,
          body:
            `NAV did not accept the data of invoice ${invoice.invoiceNumber}. Sending it again will not help; ` +
            `the data has to be corrected (usually: storno it and issue a corrected invoice).\n\n${state.messages.join("\n")}`,
        });
      } else if (state.state === "waiting" && waited > PATIENCE) {
        problems.push({
          key: `nav-waiting:${invoice.id}`,
          subject: `${invoice.invoiceNumber}: not at NAV after an hour`,
          body: `NAV has not accepted invoice ${invoice.invoiceNumber} after an hour. The checker keeps trying.\n\nState: ${state.reason}`,
        });
      }
    } catch (error) {
      log.error({ err: error, invoice: invoice.invoiceNumber }, "NAV report not advanced");
      if (waited > PATIENCE) {
        problems.push({
          key: `nav-waiting:${invoice.id}`,
          subject: `${invoice.invoiceNumber}: not at NAV after an hour`,
          body: `NAV has not accepted invoice ${invoice.invoiceNumber} after an hour. The checker keeps trying.\n\nError: ${describe(error)}`,
        });
      }
    }
  }

  // Invoices waiting for an email: only once NAV accepted them, where there is a NAV.
  const unsent = await db
    .select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber })
    .from(invoices)
    .leftJoin(emailLog, eq(emailLog.dedupeKey, sql`'invoice:' || ${invoices.id}`))
    .where(
      and(
        sql`${invoices.emailTo} is not null`,
        sql`(${emailLog.id} is null or ${emailLog.status} in ('failed', 'sending'))`,
        deps.nav
          ? sql`exists (select 1 from ${navSubmissions} where ${navSubmissions.invoiceId} = ${invoices.id} and ${navSubmissions.status} in ('done', 'warning'))`
          : undefined,
      ),
    );
  if (deps.nav || !deps.production) {
    for (const invoice of unsent) {
      await sendInvoiceEmail(deps, invoice.id).catch((error) =>
        log.error({ err: error, invoice: invoice.invoiceNumber }, "invoice email failed"),
      );
    }
  }

  // Emails that went and came back.
  if (deps.undelivered) {
    try {
      const returned = await deps.undelivered();
      const ids = returned.map((one) => one.messageId);
      if (ids.length > 0) {
        const byId = new Map(returned.map((one) => [one.messageId, one]));
        const hit = await db
          .select()
          .from(emailLog)
          .where(and(inArray(emailLog.providerMessageId, ids), eq(emailLog.status, "sent")));
        for (const row of hit) {
          const event = byId.get(row.providerMessageId!)!;
          await db
            .update(emailLog)
            .set({ status: "bounced", lastError: `${event.event}: ${event.reason ?? ""}`.trim(), updatedAt: now })
            .where(eq(emailLog.id, row.id));
        }
      }
    } catch (error) {
      log.warn({ err: error }, "could not ask the email provider about undelivered emails");
    }
  }

  const troubled = await db
    .select({ email: emailLog, invoiceNumber: invoices.invoiceNumber })
    .from(emailLog)
    .leftJoin(invoices, eq(invoices.id, emailLog.invoiceId))
    .where(and(inArray(emailLog.status, ["failed", "bounced"]), gte(emailLog.createdAt, new Date(now.getTime() - 30 * 24 * HOUR))));
  for (const { email, invoiceNumber } of troubled) {
    if (email.status === "bounced") {
      problems.push({
        key: `email-bounced:${email.id}`,
        subject: `${invoiceNumber ?? email.template}: the email bounced`,
        body:
          `The email (${email.template}) to ${email.recipient} was not delivered: ${email.lastError ?? "no reason given"}.\n\n` +
          "The address is probably mistyped. Get the right one from the buyer and resend the invoice: POST /v1/invoices/<id>/resend.",
      });
    } else if (now.getTime() - email.createdAt.getTime() > PATIENCE) {
      problems.push({
        key: `email-failing:${email.id}`,
        subject: `${invoiceNumber ?? email.template}: email not sent for an hour`,
        body: `The email (${email.template}) has failed ${email.attemptCount} time(s).\n\nError: ${email.lastError ?? "unknown"}`,
      });
    }
  }

  await settleAlerts(deps, problems, ["nav-", "email-"]);
}

/**
 * Raises what is new, resolves what is gone, and emails both. Only alerts
 * whose keys start with one of the prefixes are resolved here: the nightly
 * check owns its own, which this pass never sees.
 */
async function settleAlerts(deps: CheckerDeps, problems: readonly Problem[], prefixes: readonly string[]): Promise<void> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const current = new Set(problems.map((problem) => problem.key));

  for (const problem of problems) {
    await db
      .insert(alerts)
      .values({ ...problem, raisedAt: now })
      .onConflictDoUpdate({
        target: alerts.key,
        // A problem that comes back after being resolved is raised again.
        set: {
          subject: problem.subject,
          body: problem.body,
          raisedAt: sql`case when ${alerts.resolvedAt} is null then ${alerts.raisedAt} else ${now.toISOString()}::timestamptz end`,
          notifiedAt: sql`case when ${alerts.resolvedAt} is null then ${alerts.notifiedAt} else null end`,
          resolvedAt: null,
        },
      });
  }

  const open = await db.select().from(alerts).where(isNull(alerts.resolvedAt));
  for (const alert of open) {
    if (!current.has(alert.key) && prefixes.some((prefix) => alert.key.startsWith(prefix))) {
      await db.update(alerts).set({ resolvedAt: now }).where(eq(alerts.id, alert.id));
      if (alert.notifiedAt && deps.alertTo && deps.mailer) {
        await deps
          .mailer({ to: deps.alertTo, ...alertResolvedEmail(alert.subject, deps.isTest) })
          .catch((error) => deps.log.error({ err: error, alert: alert.key }, "resolution not sent"));
      }
      continue;
    }
    if (!alert.notifiedAt && deps.alertTo && deps.mailer) {
      try {
        await deps.mailer({ to: deps.alertTo, ...alertEmail(alert.subject, alert.body, deps.isTest) });
        await db.update(alerts).set({ notifiedAt: now }).where(eq(alerts.id, alert.id));
      } catch (error) {
        deps.log.error({ err: error, alert: alert.key }, "alert not sent");
      }
    }
  }
}

/**
 * The nightly check, both ways: every invoice NAV accepted from us must be in
 * NAV's own list with the same amounts, NAV's list must hold nothing in our
 * series that we did not issue, and every stored PDF must still match its
 * fingerprint. A week is looked at each night, so a night the check could
 * not run is covered by the next.
 */
export async function reconcile(deps: CheckerDeps): Promise<void> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const from = budapestDate(new Date(now.getTime() - 7 * 24 * HOUR));
  const to = budapestDate(now);
  const problems: Problem[] = [];

  const ours = await db.select().from(invoices).where(gte(invoices.issueDate, from));

  if (deps.nav) {
    const theirs = await deps.nav.queryInvoiceDigest(from, to);
    const theirsByNumber = new Map(theirs.map((one) => [one.invoiceNumber, one]));
    const accepted = new Set(
      (
        await db
          .select({ invoiceId: navSubmissions.invoiceId })
          .from(navSubmissions)
          .where(inArray(navSubmissions.status, ["done", "warning"]))
      ).map((row) => row.invoiceId),
    );

    for (const invoice of ours.filter((one) => accepted.has(one.id))) {
      const listed = theirsByNumber.get(invoice.invoiceNumber);
      if (!listed) {
        problems.push({
          key: `reconcile:missing:${invoice.invoiceNumber}`,
          subject: `${invoice.invoiceNumber}: missing from NAV's list`,
          body: `NAV reported invoice ${invoice.invoiceNumber} as accepted, but it is not in NAV's invoice list tonight.`,
        });
      } else if (listed.netAmount !== invoice.totalNet || listed.vatAmount !== invoice.totalVat) {
        problems.push({
          key: `reconcile:amounts:${invoice.invoiceNumber}`,
          subject: `${invoice.invoiceNumber}: NAV holds different amounts`,
          body: `Ours: net ${invoice.totalNet}, VAT ${invoice.totalVat}. NAV's: net ${listed.netAmount}, VAT ${listed.vatAmount}.`,
        });
      }
    }

    const ourNumbers = new Set(ours.map((one) => one.invoiceNumber));
    for (const listed of theirs) {
      if (ourNumbers.has(listed.invoiceNumber)) continue;
      // Only our own series is ours to account for: the same taxpayer may
      // invoice from other programs under other prefixes.
      if (parseInvoiceNumber(listed.invoiceNumber)?.prefix !== deps.numberFormat.prefix) continue;
      problems.push({
        key: `reconcile:unknown:${listed.invoiceNumber}`,
        subject: `${listed.invoiceNumber}: at NAV but not issued here`,
        body:
          `NAV's list holds invoice ${listed.invoiceNumber} (${listed.issueDate}, ${listed.operation}) in this server's ` +
          `series, but this server did not issue it. Is another program reporting with the same prefix?`,
      });
    }
  }

  for (const invoice of ours) {
    const found = await deps.store.get(invoice.pdfPath).then(sha256Of, () => "missing");
    if (found !== invoice.pdfSha256) {
      problems.push({
        key: `pdf:${invoice.id}`,
        subject: `${invoice.invoiceNumber}: stored PDF ${found === "missing" ? "missing" : "changed"}`,
        body: `The PDF of invoice ${invoice.invoiceNumber} (${invoice.pdfPath}) ${found === "missing" ? "cannot be read" : "no longer matches the fingerprint taken when it was issued"}.`,
      });
    }
  }

  await settleAlerts(deps, problems, ["reconcile:", "pdf:"]);
}

/** Mail services cap an email's size, so a big month goes in several emails under this. */
const PART_LIMIT = 8 * 1024 * 1024;

/**
 * A copy of a month's invoices, emailed after the month ends: every PDF as
 * issued, and the same invoices as the XML of the tax authority's export. A
 * second copy outside the server, for the day the storage is not there.
 */
export async function monthlyArchive(deps: CheckerDeps, month: string, to: string): Promise<number> {
  if (!deps.mailer) throw new Error("no mail service to send the archive with");
  const { from, until } = monthBounds(month);
  const rows = await deps.db
    .select()
    .from(invoices)
    .where(and(gte(invoices.issueDate, from), lt(invoices.issueDate, until)))
    .orderBy(asc(invoices.invoiceNumber));

  const lastDay = new Date(`${until}T00:00:00Z`);
  lastDay.setUTCDate(lastDay.getUTCDate() - 1);
  const { zip: xml } = await exportInvoices(deps.db, { issuedFrom: from, issuedTo: lastDay.toISOString().slice(0, 10) });

  const parts: Record<string, Uint8Array>[] = [{ [`szamlak-${month}-xml.zip`]: xml }];
  let size = xml.length;
  for (const row of rows) {
    const pdf = await deps.store.get(row.pdfPath);
    if (size + pdf.length > PART_LIMIT) {
      parts.push({});
      size = 0;
    }
    parts.at(-1)![`${row.invoiceNumber.replaceAll("/", "-")}.pdf`] = pdf;
    size += pdf.length;
  }

  for (const [index, files] of parts.entries()) {
    const part = parts.length > 1 ? ` (${index + 1}/${parts.length})` : "";
    await deps.mailer({
      to,
      ...archiveEmail(month, rows.length, part, deps.isTest),
      attachments: [{ name: `szamlak-${month}${parts.length > 1 ? `-${index + 1}` : ""}.zip`, content: zipSync(files) }],
    });
  }
  return rows.length;
}

/**
 * Runs a job unless another process is already running it — during a deploy
 * the old and the new server overlap for a moment. The lock is Postgres's and
 * goes with the transaction, so a process that dies holding it lets go.
 */
async function exclusively(db: Database, name: string, job: () => Promise<void>): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtext(${`szamlazo:${name}`})) as locked`,
    );
    if (!row?.locked) return false;
    const startedAt = new Date();
    let outcome = "ok";
    try {
      await job();
    } catch (error) {
      outcome = describe(error).slice(0, 500);
      throw error;
    } finally {
      await db
        .insert(jobRuns)
        .values({ name, lastStartedAt: startedAt, lastFinishedAt: new Date(), lastOutcome: outcome })
        .onConflictDoUpdate({
          target: jobRuns.name,
          set: { lastStartedAt: startedAt, lastFinishedAt: new Date(), lastOutcome: outcome },
        });
    }
    return true;
  });
}

/**
 * Runs a job with the checker held off, waiting for a pass in progress to
 * finish first, so the checker and an API request never report the same
 * invoice to NAV at the same moment.
 */
export async function withCheckerHeld<T>(db: Database, job: () => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"szamlazo:checks"}))`);
    return job();
  });
}

/** One tick: the checks every time; the archive and the nightly check once a night after three. */
export async function tick(deps: CheckerDeps): Promise<void> {
  await exclusively(deps.db, "checks", () => runChecks(deps));

  const now = deps.now?.() ?? new Date();
  if (budapestHour(now) < 3) return;

  if (deps.archiveTo && deps.mailer) {
    const month = previousMonth(now);
    const name = `archive:${month}`;
    const [sent] = await deps.db.select().from(jobRuns).where(eq(jobRuns.name, name));
    if (sent?.lastOutcome !== "ok") {
      await exclusively(deps.db, name, async () => {
        await monthlyArchive(deps, month, deps.archiveTo!);
      }).catch((error) => deps.log.error({ err: error, month }, "monthly archive not sent"));
    }
  }

  const [last] = await deps.db.select().from(jobRuns).where(eq(jobRuns.name, "reconcile"));
  if (last?.lastFinishedAt && budapestDate(last.lastFinishedAt) === budapestDate(now) && last.lastOutcome === "ok") return;
  await exclusively(deps.db, "reconcile", () => reconcile(deps));
}

/**
 * Runs the checker on a timer and pings a heartbeat after every pass. A
 * checker that stops — crashed, hung, or its server gone — stops pinging,
 * and Healthchecks.io emails: the one alert this program cannot send about
 * itself.
 */
export function startChecker(deps: CheckerDeps, options: { intervalMs: number; heartbeatUrl?: string }): () => void {
  let running = false;
  const beat = (suffix: string) =>
    options.heartbeatUrl
      ? fetch(`${options.heartbeatUrl}${suffix}`, { method: "POST", signal: AbortSignal.timeout(10_000) }).catch(() => undefined)
      : undefined;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      await tick(deps);
      await beat("");
    } catch (error) {
      deps.log.error({ err: error }, "checker pass failed");
      await beat("/fail");
    } finally {
      running = false;
    }
  };

  const first = setTimeout(run, 15_000);
  const timer = setInterval(run, options.intervalMs);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
