import { date, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Money is `integer`: whole forints, never a float. Every timestamp is stored
 * with its time zone and read as UTC; only what people read is converted to
 * Budapest time.
 */

const money = (name: string) => integer(name).notNull();
const createdAt = timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const invoiceType = pgEnum("invoice_type", ["normal", "storno"]);
export const paymentMethod = pgEnum("payment_method", ["card", "transfer", "cash", "other"]);
export const navStatus = pgEnum("nav_submission_status", ["pending", "sent", "done", "warning", "error"]);

/**
 * Append-only: a trigger refuses UPDATE and DELETE (migration 0001). A
 * correction is a new storno row pointing at the original.
 */
export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceNumber: text("invoice_number").notNull().unique(),
    type: invoiceType("type").notNull(),
    originalInvoiceId: uuid("original_invoice_id"),
    /**
     * The caller's own key for what is being invoiced — an order number, a
     * booking id. Asking twice with the same reference returns the first
     * invoice instead of issuing a second one.
     */
    reference: text("reference"),
    /** A fingerprint of the request, so a reused reference with different content is refused. */
    requestHash: text("request_hash"),
    issueDate: date("issue_date").notNull(),
    fulfilmentDate: date("fulfilment_date").notNull(),
    dueDate: date("due_date").notNull(),
    sellerSnapshot: jsonb("seller_snapshot").notNull(),
    buyerSnapshot: jsonb("buyer_snapshot").notNull(),
    lines: jsonb("lines").notNull(),
    totalNet: money("total_net"),
    totalVat: money("total_vat"),
    totalGross: money("total_gross"),
    paymentMethod: paymentMethod("payment_method").notNull(),
    currency: text("currency").notNull().default("HUF"),
    note: text("note"),
    /** Where the invoice is emailed; null when nobody is to be emailed. */
    emailTo: text("email_to"),
    pdfPath: text("pdf_path").notNull(),
    pdfSha256: text("pdf_sha256").notNull(),
    /** Who issued it: an API key's name, or "cli". */
    createdBy: text("created_by").notNull(),
    createdAt,
  },
  (table) => [
    uniqueIndex("invoices_one_normal_per_reference")
      .on(table.reference)
      .where(sql`${table.type} = 'normal' and ${table.reference} is not null`),
    uniqueIndex("invoices_one_storno_per_original")
      .on(table.originalInvoiceId)
      .where(sql`${table.type} = 'storno'`),
  ],
);

/**
 * One row holding the last number issued, locked with SELECT … FOR UPDATE in
 * the transaction that inserts the invoice: no gaps, no duplicates.
 */
export const invoiceSequence = pgTable("invoice_sequence", {
  id: integer("id").primaryKey().default(1),
  lastNumber: integer("last_number").notNull().default(0),
  updatedAt,
});

/** One row per attempt to report an invoice, with what was sent and what came back. */
export const navSubmissions = pgTable("nav_submissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => invoices.id, { onDelete: "restrict" }),
  transactionId: text("transaction_id"),
  status: navStatus("status").notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  requestXml: text("request_xml"),
  responseXml: text("response_xml"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt,
});

/**
 * Every email, one row per email rather than per attempt. The dedupe key is
 * what makes sending safe to repeat: only whoever inserts the row sends.
 */
export const emailLog = pgTable("email_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  recipient: text("recipient").notNull(),
  template: text("template").notNull(),
  invoiceId: uuid("invoice_id").references(() => invoices.id, { onDelete: "restrict" }),
  dedupeKey: text("dedupe_key").notNull().unique(),
  providerMessageId: text("provider_message_id"),
  /** sending, sent, failed or bounced. */
  status: text("status").notNull(),
  attemptCount: integer("attempt_count").notNull().default(0),
  lastError: text("last_error"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt,
  updatedAt,
});

/** Something a person has to know about, raised once and resolved when it is gone. */
export const alerts = pgTable("alerts", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  raisedAt: timestamp("raised_at", { withTimezone: true }).notNull().defaultNow(),
  notifiedAt: timestamp("notified_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

/** When each scheduled job last ran, so a nightly one runs once a night. */
export const jobRuns = pgTable("job_runs", {
  name: text("name").primaryKey(),
  lastStartedAt: timestamp("last_started_at", { withTimezone: true }),
  lastFinishedAt: timestamp("last_finished_at", { withTimezone: true }),
  lastOutcome: text("last_outcome"),
});

/** Who did what, append-only like the invoices. */
export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  entity: text("entity").notNull(),
  entityId: text("entity_id").notNull(),
  action: text("action").notNull(),
  actor: text("actor").notNull(),
  details: jsonb("details"),
  createdAt,
});
