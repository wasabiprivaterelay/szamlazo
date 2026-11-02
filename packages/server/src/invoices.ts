import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  issueInvoice,
  renderInvoicePdf,
  stornoInvoice,
  yearOf,
  type Invoice,
  type InvoiceLine,
  type LineInput,
  type NumberFormat,
  type Party,
  type PdfOptions,
} from "@szamlazo/invoicing";
import type { Taxpayer } from "@szamlazo/nav";
import type { Database, Transaction } from "./db/client.js";
import { auditLog, invoices } from "./db/schema.js";
import { sequenceSourceFor } from "./db/sequence.js";
import { addDays, day, dayOf, isoDay } from "./dates.js";
import { invoicePath, type InvoiceStore } from "./storage.js";

/**
 * Issuing invoices and reversing them. Everything for one invoice happens in
 * one transaction: the number is drawn, the PDF rendered and stored, and the
 * row written. If any of it fails the number goes back, so the sequence never
 * has a gap.
 */

/** Text that XML, a PDF and an email can all carry: no control characters. */
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
     
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  .refine((value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F￾￿]/.test(value), "contains a control character");

/** A free-text note on an invoice: line breaks allowed, other control characters not. */
export const noteSchema = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  .refine((value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFE\uFFFF]/.test(value), "contains a control character");

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date like 2026-09-22")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && isoDay(day(value)) === value, "is not a real date");

/**
 * The Hungarian VAT rates. 0 means no VAT, and then the line says why in
 * vatExemption (or, for an alanyi adómentes seller, the server says AAM).
 */
export const VAT_RATES = [0, 5, 18, 27] as const;

export const VAT_EXEMPTION_CASES = ["AAM", "TAM", "ATK", "REVERSE_CHARGE"] as const;

/**
 * What is printed and reported when a line does not give its own reason. A
 * tárgyi adómentes supply has no default: which paragraph of Áfa tv. 85.–86. §
 * applies depends on what is sold, and only the seller knows.
 */
const DEFAULT_EXEMPTION_REASONS: Record<(typeof VAT_EXEMPTION_CASES)[number], string | undefined> = {
  AAM: "Alanyi adómentes (Áfa tv. XIII. fejezet)",
  TAM: undefined,
  ATK: "Az Áfa tv. hatályán kívüli ügylet",
  REVERSE_CHARGE: "Fordított adózás (Áfa tv. 142. §)",
};

/** Big enough for any real invoice, small enough that no sum can overflow a Postgres integer. */
const MAX_LINE_GROSS = 1_000_000_000;

const lineSchema = z.object({
  description: text(500),
  quantity: z.number().int().min(1).max(1_000_000),
  unit: text(30),
  /** Whole forints, VAT included. */
  unitPriceGross: z.number().int().min(0).max(MAX_LINE_GROSS),
  vatRate: z.literal(VAT_RATES),
  /** Why a 0% line has no VAT. */
  vatExemption: z
    .object({
      case: z.enum(VAT_EXEMPTION_CASES),
      /** The legal reference printed on the invoice. Required for TAM. */
      reason: text(200).optional(),
    })
    .strict()
    .optional(),
});

const buyerSchema = z
  .object({
    type: z.enum(["private", "company"]),
    name: text(200),
    postcode: z.string().trim().regex(/^\d{4}$/, "must be a four-digit Hungarian postcode"),
    city: text(100),
    address: text(200),
    /** Required for a company: the full 11 digits, with or without dashes. */
    taxNumber: z
      .string()
      .trim()
      .transform((value) => value.replace(/[\s-]/g, ""))
      .refine((digits) => /^\d{11}$/.test(digits), "must be a full 11-digit tax number, e.g. 12345678-2-41")
      .optional(),
    email: z.email().max(254).optional(),
  })
  .refine((buyer) => buyer.type === "private" || buyer.taxNumber !== undefined, {
    message: "a company buyer needs its tax number",
    path: ["taxNumber"],
  })
  .refine((buyer) => buyer.type === "company" || buyer.taxNumber === undefined, {
    message: "a private buyer has no tax number on the invoice; use type company for a business",
    path: ["taxNumber"],
  });

export const issueRequestSchema = z
  .object({
    /** The caller's own id for what is invoiced. The same reference twice returns the first invoice. */
    reference: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._:/#-]{1,100}$/, "use 1–100 letters, digits and . _ : / # -")
      .optional(),
    buyer: buyerSchema,
    lines: z.array(lineSchema).min(1).max(100),
    paymentMethod: z.enum(["card", "transfer", "cash", "other"]),
    /** Teljesítés dátuma. Defaults to today in Hungary. */
    fulfilmentDate: isoDate.optional(),
    /** Fizetési határidő. Defaults to today, or PAYMENT_TERM_DAYS ahead for a transfer. */
    dueDate: isoDate.optional(),
    note: noteSchema.optional(),
    /** Email the invoice to buyer.email once NAV has accepted it. Default true. */
    sendEmail: z.boolean().default(true),
  })
  .strict()
  .refine((request) => request.lines.reduce((sum, line) => sum + line.unitPriceGross * line.quantity, 0) <= MAX_LINE_GROSS, {
    message: "the invoice total is larger than this server handles",
    path: ["lines"],
  });

export type IssueRequest = z.infer<typeof issueRequestSchema>;

export type IssueSettings = {
  seller: Party;
  /** The seller is alanyi adómentes (AAM): no line may carry VAT. */
  sellerAam?: boolean;
  numberFormat: NumberFormat;
  paymentTermDays: number;
  pdf: Omit<PdfOptions, "createdAt">;
};

export type IssuedInvoice = {
  invoice: typeof invoices.$inferSelect;
  alreadyIssued: boolean;
};

export class IssueRefused extends Error {
  constructor(
    message: string,
    readonly code: "REFERENCE_CONFLICT" | "TAXPAYER_INVALID" | "DATE_INVALID" | "VAT_INVALID" | "NOT_FOUND" | "ALREADY_STORNO",
  ) {
    super(message);
    this.name = "IssueRefused";
  }
}

/** A stable fingerprint of what was asked for, to tell a retry from a different request. */
function fingerprint(request: IssueRequest): string {
  const canonical = JSON.stringify(request, (_, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );
  return createHash("sha256").update(canonical).digest("hex");
}

const formatTax = (digits: string) => `${digits.slice(0, 8)}-${digits.slice(8, 9)}-${digits.slice(9)}`;

/**
 * A company buyer is checked against NAV's register before an invoice with
 * its name on it exists. A number NAV does not know is refused. NAV being
 * unreachable is not a reason to refuse, because the full 11 digits are
 * already in hand; the invoice goes out and NAV checks it when reported.
 */
async function confirmedBuyer(
  buyer: IssueRequest["buyer"],
  lookup: ((taxNumber: string) => Promise<Taxpayer>) | undefined,
): Promise<Party> {
  const party: Party = {
    name: buyer.name,
    postcode: buyer.postcode,
    city: buyer.city,
    address: buyer.address,
    countryCode: "HU",
    email: buyer.email,
  };
  if (buyer.type === "private") return party;

  const digits = buyer.taxNumber!;
  if (lookup) {
    const found = await lookup(digits).catch(() => undefined);
    if (found && !found.valid) {
      throw new IssueRefused(`NAV does not know ${formatTax(digits)} as a valid taxpayer`, "TAXPAYER_INVALID");
    }
    if (found?.valid && (found.vatCode !== digits.slice(8, 9) || found.countyCode !== digits.slice(9))) {
      throw new IssueRefused(
        `NAV knows ${digits.slice(0, 8)} as ${digits.slice(0, 8)}-${found.vatCode ?? "?"}-${found.countyCode ?? "??"}, not ${formatTax(digits)}`,
        "TAXPAYER_INVALID",
      );
    }
  }
  return { ...party, taxNumber: formatTax(digits) };
}

async function storeAndRecord(
  tx: Transaction,
  store: InvoiceStore,
  invoice: Invoice,
  settings: IssueSettings,
  row: {
    type: "normal" | "storno";
    originalInvoiceId?: string;
    reference?: string;
    requestHash?: string;
    emailTo?: string;
    actor: string;
  },
) {
  const pdf = await renderInvoicePdf(invoice, { ...settings.pdf, createdAt: invoice.issueDate });
  // Stored before the row is written, so a row never points at a file that is
  // not there. A transaction that fails later leaves an unreferenced file,
  // which the next invoice drawing the same number overwrites.
  const stored = await store.put(invoicePath(invoice.invoiceNumber, yearOf(invoice.issueDate)), pdf);

  const [inserted] = await tx
    .insert(invoices)
    .values({
      invoiceNumber: invoice.invoiceNumber,
      type: row.type,
      originalInvoiceId: row.originalInvoiceId,
      reference: row.reference,
      requestHash: row.requestHash,
      issueDate: isoDay(invoice.issueDate),
      fulfilmentDate: isoDay(invoice.fulfilmentDate),
      dueDate: isoDay(invoice.dueDate),
      sellerSnapshot: invoice.seller,
      buyerSnapshot: invoice.buyer,
      lines: invoice.lines,
      totalNet: invoice.totalNet,
      totalVat: invoice.totalVat,
      totalGross: invoice.totalGross,
      paymentMethod: invoice.paymentMethod,
      currency: invoice.currency,
      note: invoice.note,
      emailTo: row.emailTo,
      pdfPath: stored.path,
      pdfSha256: stored.sha256,
      createdBy: row.actor,
    })
    .returning();

  await tx.insert(auditLog).values({
    entity: "invoice",
    entityId: inserted!.id,
    action: row.type === "storno" ? "storno issued" : "invoice issued",
    actor: row.actor,
    details: { invoiceNumber: invoice.invoiceNumber, totalGross: invoice.totalGross, reference: row.reference ?? null },
  });
  return inserted!;
}

/**
 * Settles each line's VAT treatment, or refuses the request with the reason.
 * The rules: a 0% line says why; a line that says why is 0%; AAM is the
 * seller's status, so it is all lines or none and only for an AAM seller;
 * TAM must name its legal ground; reverse charge needs a business buyer.
 */
export function resolveVat(request: IssueRequest, settings: Pick<IssueSettings, "sellerAam">): LineInput[] {
  const refuse = (message: string): never => {
    throw new IssueRefused(message, "VAT_INVALID");
  };
  return request.lines.map((line, index) => {
    const where = `lines.${index}`;
    let exemption = line.vatExemption;
    if (settings.sellerAam) {
      if (line.vatRate !== 0) refuse(`${where}: the seller is alanyi adómentes (SELLER_AAM), so every line has vatRate 0`);
      exemption ??= { case: "AAM" };
      if (exemption.case !== "AAM") refuse(`${where}: an alanyi adómentes seller's lines are all AAM`);
    } else if (exemption?.case === "AAM") {
      refuse(`${where}: AAM is only for a seller who is alanyi adómentes; set SELLER_AAM=true if you are`);
    }
    if (line.vatRate !== 0) {
      if (exemption) refuse(`${where}: a line with vatExemption must have vatRate 0`);
      return { ...line, vatExemption: undefined };
    }
    if (!exemption) refuse(`${where}: a 0% line needs vatExemption saying why: TAM, ATK or REVERSE_CHARGE`);
    const reason = exemption!.reason ?? DEFAULT_EXEMPTION_REASONS[exemption!.case];
    if (!reason) refuse(`${where}: a TAM line needs vatExemption.reason, the legal ground, e.g. "Áfa tv. 85. § (1) e)"`);
    if (exemption!.case === "REVERSE_CHARGE" && request.buyer.type !== "company") {
      refuse(`${where}: reverse charge (fordított adózás) needs a company buyer with a tax number`);
    }
    return { ...line, vatExemption: { case: exemption!.case, reason: reason! } };
  });
}

export async function issue(
  db: Database,
  store: InvoiceStore,
  settings: IssueSettings,
  request: IssueRequest,
  options: {
    actor: string;
    lookupTaxpayer?: (taxNumber: string) => Promise<Taxpayer>;
    now?: Date;
  },
): Promise<IssuedInvoice> {
  const now = options.now ?? new Date();
  const today = dayOf(now);
  const hash = fingerprint(request);

  const fulfilment = request.fulfilmentDate ? day(request.fulfilmentDate) : today;
  const due = request.dueDate
    ? day(request.dueDate)
    : request.paymentMethod === "transfer"
      ? addDays(today, settings.paymentTermDays)
      : today;
  if (due < today) throw new IssueRefused("the due date cannot be before the day of issue", "DATE_INVALID");
  if (Math.abs(fulfilment.getTime() - today.getTime()) > 366 * 24 * 60 * 60_000) {
    throw new IssueRefused("the fulfilment date is more than a year from today", "DATE_INVALID");
  }

  const lines = resolveVat(request, settings);

  // The NAV lookup happens before the transaction, so no lock is held while
  // waiting for NAV. Only a request with a reference can be a retry.
  const existingFor = async (tx: Transaction | Database) => {
    if (!request.reference) return undefined;
    const [found] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.reference, request.reference), eq(invoices.type, "normal")));
    return found;
  };
  const early = await existingFor(db);
  if (early) return settleRetry(early);

  const buyer = await confirmedBuyer(request.buyer, options.lookupTaxpayer);

  return db.transaction(async (tx) => {
    if (request.reference) {
      // Two requests with the same reference at the same moment queue up here
      // instead of both deciding to issue.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`szamlazo:reference:${request.reference}`}))`);
      const raced = await existingFor(tx);
      if (raced) return settleRetry(raced);
    }

    const invoice = await issueInvoice(
      {
        seller: settings.seller,
        buyer,
        lines,
        issueDate: today,
        fulfilmentDate: fulfilment,
        dueDate: due,
        paymentMethod: request.paymentMethod,
        note: request.note,
        orderNumber: request.reference,
      },
      { sequence: sequenceSourceFor(tx), numberFormat: settings.numberFormat },
    );

    const row = await storeAndRecord(tx, store, invoice, settings, {
      type: "normal",
      reference: request.reference,
      requestHash: hash,
      emailTo: request.sendEmail ? request.buyer.email : undefined,
      actor: options.actor,
    });
    return { invoice: row, alreadyIssued: false };
  });

  function settleRetry(found: typeof invoices.$inferSelect): IssuedInvoice {
    if (found.requestHash !== hash) {
      throw new IssueRefused(
        `reference ${request.reference} already has invoice ${found.invoiceNumber} with different content`,
        "REFERENCE_CONFLICT",
      );
    }
    return { invoice: found, alreadyIssued: true };
  }
}

/**
 * Reverses an invoice completely: the same lines negated, numbered from the
 * same sequence, built from what the invoice recorded rather than from
 * anything that may have changed since. Asking twice returns the first storno.
 */
export async function storno(
  db: Database,
  store: InvoiceStore,
  settings: IssueSettings,
  invoiceId: string,
  options: { actor: string; note?: string; now?: Date },
): Promise<IssuedInvoice> {
  const today = dayOf(options.now ?? new Date());

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`szamlazo:storno:${invoiceId}`}))`);
    const [original] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
    if (!original) throw new IssueRefused(`no invoice with id ${invoiceId}`, "NOT_FOUND");
    if (original.type === "storno") {
      throw new IssueRefused(`${original.invoiceNumber} is itself a storno and cannot be reversed`, "ALREADY_STORNO");
    }

    const [existing] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.originalInvoiceId, original.id), eq(invoices.type, "storno")));
    if (existing) return { invoice: existing, alreadyIssued: true };

    const reversed = await stornoInvoice(
      {
        invoiceNumber: original.invoiceNumber,
        type: "normal",
        seller: original.sellerSnapshot as Party,
        buyer: original.buyerSnapshot as Party,
        lines: original.lines as InvoiceLine[],
        vatSummary: [],
        totalNet: original.totalNet,
        totalVat: original.totalVat,
        totalGross: original.totalGross,
        issueDate: day(original.issueDate),
        fulfilmentDate: day(original.fulfilmentDate),
        dueDate: day(original.dueDate),
        paymentMethod: original.paymentMethod,
        currency: original.currency,
        orderNumber: original.reference ?? undefined,
      },
      {
        sequence: sequenceSourceFor(tx),
        numberFormat: settings.numberFormat,
        issueDate: today < day(original.issueDate) ? day(original.issueDate) : today,
        note: options.note,
      },
    );

    const row = await storeAndRecord(tx, store, reversed, settings, {
      type: "storno",
      originalInvoiceId: original.id,
      emailTo: original.emailTo ?? undefined,
      actor: options.actor,
    });
    return { invoice: row, alreadyIssued: false };
  });
}
