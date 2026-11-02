import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { and, count, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { NavError } from "@szamlazo/nav";
import { advanceInvoice, sendInvoiceEmail, withCheckerHeld } from "../checker.js";
import { alerts, auditLog, emailLog, invoices, jobRuns, navSubmissions } from "../db/schema.js";
import { IssueRefused, issue, issueRequestSchema, noteSchema, storno } from "../invoices.js";
import type { Services } from "../services.js";
import { sha256Of } from "../storage.js";
import { exportInvoices } from "../tax-export.js";
import { bearerOf, verifyKey } from "./auth.js";
import { rateLimiter } from "./rate-limit.js";

/**
 * The HTTP API. Every route under /v1 needs an API key; /health does not,
 * and says nothing but whether the database answers. Errors have one shape:
 * { "error": { "code": "...", "message": "...", "details"?: [...] } }.
 */

type Variables = { actor: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export type AppOptions = {
  /** The client's address; the server passes the socket's, tests pass a fixed one. */
  clientIp?: (context: Context) => string;
  now?: () => number;
  /** Run after an invoice is issued, to report and email it soon; the checker catches up otherwise. */
  afterIssue?: (invoiceId: string) => void;
};

function problem(context: Context, status: 400 | 401 | 404 | 409 | 413 | 422 | 429 | 500 | 503, code: string, message: string, details?: unknown) {
  return context.json({ error: { code, message, ...(details === undefined ? {} : { details }) } }, status);
}

export function createApp(services: Services, options: AppOptions = {}) {
  const { db, store, settings, env, log } = services;
  const app = new Hono<{ Variables: Variables }>();
  const now = options.now ?? Date.now;
  const clientIp = options.clientIp ?? (() => "unknown");

  // Wrong keys: 20 per client per ten minutes, then the client waits.
  const failures = rateLimiter({ max: 20, perMs: 10 * 60_000 }, now);
  // Work done with a valid key: generous, but a runaway script stops.
  const perKey = rateLimiter({ max: 600, perMs: 60_000 }, now);

  app.use(secureHeaders({ crossOriginResourcePolicy: "same-origin", xFrameOptions: "DENY" }));
  app.use(async (context, next) => {
    await next();
    // Invoices are personal data: no proxy or browser keeps a copy.
    context.header("Cache-Control", "no-store");
  });

  app.get("/health", async (context) => {
    try {
      await db.execute(sql`select 1`);
      return context.json({ status: "ok", database: "ok" });
    } catch {
      return context.json({ status: "error", database: "unreachable" }, 503);
    }
  });

  app.use("/v1/*", async (context, next) => {
    const ip = clientIp(context);
    const actor = verifyKey(bearerOf(context.req.header("authorization")), env.API_KEYS);
    if (!actor) {
      if (!failures(ip)) return problem(context, 429, "TOO_MANY_ATTEMPTS", "Too many requests with a wrong API key. Wait ten minutes.");
      log.warn({ ip, path: context.req.path }, "request with a missing or wrong API key");
      return problem(context, 401, "UNAUTHORIZED", "Send a valid API key: Authorization: Bearer szk_…");
    }
    if (!perKey(actor)) return problem(context, 429, "RATE_LIMITED", "Too many requests for this API key; slow down.");
    context.set("actor", actor);
    await next();
  });

  app.use(
    "/v1/*",
    bodyLimit({ maxSize: 256 * 1024, onError: (context) => problem(context, 413, "TOO_LARGE", "The request body is larger than 256 KB.") }),
  );

  /** One invoice with what became of it at NAV and in the post. */
  async function view(row: typeof invoices.$inferSelect) {
    const [submission] = await db
      .select()
      .from(navSubmissions)
      .where(eq(navSubmissions.invoiceId, row.id))
      .orderBy(desc(navSubmissions.createdAt))
      .limit(1);
    const [email] = await db.select().from(emailLog).where(eq(emailLog.dedupeKey, `invoice:${row.id}`));
    const [original] = row.originalInvoiceId
      ? await db.select({ invoiceNumber: invoices.invoiceNumber }).from(invoices).where(eq(invoices.id, row.originalInvoiceId))
      : [];
    const [reversedBy] = await db
      .select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber })
      .from(invoices)
      .where(and(eq(invoices.originalInvoiceId, row.id), eq(invoices.type, "storno")));

    return {
      id: row.id,
      invoiceNumber: row.invoiceNumber,
      type: row.type,
      reference: row.reference,
      reverses: original?.invoiceNumber ?? null,
      reversedBy: reversedBy ?? null,
      issueDate: row.issueDate,
      fulfilmentDate: row.fulfilmentDate,
      dueDate: row.dueDate,
      seller: row.sellerSnapshot,
      buyer: row.buyerSnapshot,
      lines: row.lines,
      totalNet: row.totalNet,
      totalVat: row.totalVat,
      totalGross: row.totalGross,
      currency: row.currency,
      paymentMethod: row.paymentMethod,
      note: row.note,
      nav: submission
        ? {
            status: submission.status,
            transactionId: submission.transactionId,
            attempts: submission.attemptCount,
            error: submission.errorCode ? { code: submission.errorCode, message: submission.errorMessage } : null,
          }
        : { status: services.nav ? "queued" : "not configured" },
      email: row.emailTo
        ? { to: row.emailTo, status: email?.status ?? "queued", sentAt: email?.sentAt ?? null }
        : null,
      pdf: `/v1/invoices/${row.id}/pdf`,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
    };
  }

  async function invoiceOr404(context: Context) {
    const id = context.req.param("id") ?? "";
    if (!UUID.test(id)) return undefined;
    const [row] = await db.select().from(invoices).where(eq(invoices.id, id));
    return row;
  }

  app.post("/v1/invoices", async (context) => {
    const body = await context.req.json().catch(() => undefined);
    if (body === undefined) return problem(context, 400, "INVALID_JSON", "The body must be JSON.");
    const parsed = issueRequestSchema.safeParse(body);
    if (!parsed.success) {
      return problem(
        context,
        400,
        "INVALID_REQUEST",
        "The invoice request is not valid.",
        parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      );
    }
    try {
      const { invoice, alreadyIssued } = await issue(db, store, settings, parsed.data, {
        actor: context.get("actor"),
        lookupTaxpayer: services.lookupTaxpayer,
      });
      if (!alreadyIssued) options.afterIssue?.(invoice.id);
      return context.json({ alreadyIssued, invoice: await view(invoice) }, alreadyIssued ? 200 : 201);
    } catch (error) {
      if (error instanceof IssueRefused) {
        return problem(context, error.code === "REFERENCE_CONFLICT" ? 409 : 422, error.code, error.message);
      }
      throw error;
    }
  });

  app.get("/v1/invoices", async (context) => {
    const query = z
      .object({
        from: isoDate.optional(),
        to: isoDate.optional(),
        number: z.string().max(40).optional(),
        reference: z.string().max(100).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
      })
      .safeParse(context.req.query());
    if (!query.success) return problem(context, 400, "INVALID_QUERY", "Check from, to, number, reference, limit and offset.");
    const { from, to, number, reference, limit, offset } = query.data;
    const where = and(
      from ? gte(invoices.issueDate, from) : undefined,
      to ? lte(invoices.issueDate, to) : undefined,
      number ? eq(invoices.invoiceNumber, number) : undefined,
      reference ? eq(invoices.reference, reference) : undefined,
    );
    const rows = await db.select().from(invoices).where(where).orderBy(desc(invoices.createdAt)).limit(limit).offset(offset);
    const [total] = await db.select({ value: count() }).from(invoices).where(where);
    return context.json({ total: total?.value ?? 0, invoices: await Promise.all(rows.map(view)) });
  });

  app.get("/v1/invoices/:id", async (context) => {
    const row = await invoiceOr404(context);
    if (!row) return problem(context, 404, "NOT_FOUND", "No such invoice.");
    return context.json({ invoice: await view(row) });
  });

  app.get("/v1/invoices/:id/pdf", async (context) => {
    const row = await invoiceOr404(context);
    if (!row) return problem(context, 404, "NOT_FOUND", "No such invoice.");
    const pdf = await store.get(row.pdfPath);
    if (sha256Of(pdf) !== row.pdfSha256) {
      log.error({ invoice: row.invoiceNumber }, "stored PDF does not match its fingerprint");
      return problem(context, 500, "PDF_CHANGED", "The stored PDF no longer matches the one issued. It is not served.");
    }
    return new Response(pdf.slice().buffer as ArrayBuffer, {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${row.invoiceNumber.replaceAll("/", "-")}.pdf"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });

  app.post("/v1/invoices/:id/storno", async (context) => {
    const row = await invoiceOr404(context);
    if (!row) return problem(context, 404, "NOT_FOUND", "No such invoice.");
    const body = z
      .object({ note: noteSchema.optional() })
      .strict()
      .safeParse(await context.req.json().catch(() => ({})));
    if (!body.success) return problem(context, 400, "INVALID_REQUEST", "The only field is an optional note.");
    try {
      const { invoice, alreadyIssued } = await storno(db, store, settings, row.id, {
        actor: context.get("actor"),
        note: body.data.note,
      });
      if (!alreadyIssued) options.afterIssue?.(invoice.id);
      return context.json({ alreadyIssued, invoice: await view(invoice) }, alreadyIssued ? 200 : 201);
    } catch (error) {
      if (error instanceof IssueRefused) return problem(context, 422, error.code, error.message);
      throw error;
    }
  });

  app.post("/v1/invoices/:id/resend", async (context) => {
    const row = await invoiceOr404(context);
    if (!row) return problem(context, 404, "NOT_FOUND", "No such invoice.");
    const body = z.object({ to: z.email().max(254).optional() }).strict().safeParse(await context.req.json().catch(() => ({})));
    if (!body.success) return problem(context, 400, "INVALID_REQUEST", "The only field is an optional address: { \"to\": \"…\" }.");
    if (!services.checker.mailer) return problem(context, 503, "NO_MAILER", "No email service is configured.");
    const to = body.data.to ?? row.emailTo ?? undefined;
    if (!to) return problem(context, 422, "NO_RECIPIENT", "This invoice has no email address; give one as \"to\".");
    const outcome = await sendInvoiceEmail(services.checker, row.id, { copy: String(now()), to });
    await db.insert(auditLog).values({
      entity: "invoice",
      entityId: row.id,
      action: "email resent",
      actor: context.get("actor"),
      details: { to, outcome },
    });
    return context.json({ outcome, to });
  });

  app.get("/v1/taxpayers/:taxNumber", async (context) => {
    if (!services.nav) return problem(context, 503, "NAV_NOT_CONFIGURED", "This server has no NAV technical user.");
    const taxNumber = context.req.param("taxNumber");
    if (!/^\d{8}(-?\d-?\d{2})?$/.test(taxNumber)) return problem(context, 400, "INVALID_TAX_NUMBER", "Give 12345678 or 12345678-2-41.");
    try {
      return context.json({ taxpayer: await services.nav.queryTaxpayer(taxNumber) });
    } catch (error) {
      log.warn({ err: error }, "taxpayer lookup failed");
      return problem(context, 503, "NAV_UNAVAILABLE", error instanceof NavError ? `NAV refused: ${error.errorCode ?? error.message}` : "NAV did not answer.");
    }
  });

  app.get("/v1/exports/inspection", async (context) => {
    const query = z
      .union([
        z.object({ from: isoDate, to: isoDate }),
        z.object({ first: z.string().regex(/^[A-Z]{1,8}\d{4}\/\d+$/), last: z.string().regex(/^[A-Z]{1,8}\d{4}\/\d+$/) }),
      ])
      .safeParse(context.req.query());
    if (!query.success) return problem(context, 400, "INVALID_QUERY", "Give from and to (dates), or first and last (invoice numbers).");
    const selection =
      "from" in query.data
        ? { issuedFrom: query.data.from, issuedTo: query.data.to }
        : { firstNumber: query.data.first, lastNumber: query.data.last };
    const { zip, invoiceNumbers } = await exportInvoices(db, selection);
    await db.insert(auditLog).values({
      entity: "export",
      entityId: "inspection",
      action: "inspection export",
      actor: context.get("actor"),
      details: { selection, count: invoiceNumbers.length },
    });
    return new Response(zip.slice().buffer as ArrayBuffer, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": 'attachment; filename="szamlak.zip"',
        "x-invoice-count": String(invoiceNumbers.length),
        "cache-control": "no-store",
      },
    });
  });

  app.get("/v1/status", async (context) => {
    const [issued] = await db.select({ value: count() }).from(invoices);
    const awaitingNav = await db
      .select({ value: count() })
      .from(invoices)
      .where(
        sql`not exists (select 1 from ${navSubmissions} where ${navSubmissions.invoiceId} = ${invoices.id} and ${navSubmissions.status} in ('done', 'warning'))`,
      );
    const [emailsFailing] = await db.select({ value: count() }).from(emailLog).where(inArray(emailLog.status, ["failed", "bounced"]));
    const open = await db.select({ key: alerts.key, subject: alerts.subject, raisedAt: alerts.raisedAt }).from(alerts).where(isNull(alerts.resolvedAt));
    const jobs = await db.select().from(jobRuns);
    return context.json({
      environment: env.ENVIRONMENT,
      nav: services.nav ? env.nav.environment : "not configured",
      email: services.checker.mailer ? "configured" : "not configured",
      storage: env.STORAGE,
      invoices: { issued: issued?.value ?? 0, awaitingNav: awaitingNav[0]?.value ?? 0 },
      emailsFailing: emailsFailing?.value ?? 0,
      openAlerts: open,
      jobs: jobs.map((job) => ({ name: job.name, lastFinishedAt: job.lastFinishedAt, lastOutcome: job.lastOutcome })),
    });
  });

  app.notFound((context) => problem(context, 404, "NOT_FOUND", "No such route."));
  app.onError((error, context) => {
    log.error({ err: error, path: context.req.path }, "request failed");
    return problem(context, 500, "INTERNAL", "Something went wrong. The error is in the server log.");
  });

  return app;
}

/** Reports and emails a freshly issued invoice now, rather than at the checker's next pass. */
export function reportSoon(services: Services): (invoiceId: string) => void {
  return (invoiceId) => {
    void withCheckerHeld(services.db, () => advanceInvoice(services.checker, invoiceId)).catch((error) =>
      services.log.warn({ err: error, invoice: invoiceId }, "invoice not taken further yet; the checker will"),
    );
  };
}
