import { desc, eq } from "drizzle-orm";
import {
  NavError,
  invoiceDataXml,
  type NavClient,
  type NavInvoice,
  type NavLine,
  type NavParty,
  type NavVatSummary,
  type TransactionStatus,
} from "@szamlazo/nav";
import type { InvoiceLine, Party } from "@szamlazo/invoicing";
import type { Database } from "./db/client.js";
import { invoices, navSubmissions } from "./db/schema.js";

/**
 * Reporting an issued invoice to NAV, and keeping a record of having done so.
 * The report is built from what the invoice row recorded — its snapshots and
 * its frozen lines — never from anything that may have changed since.
 */

/** 12345678-2-41 in its three parts, which is how NAV takes a tax number. */
function splitTaxNumber(taxNumber: string | undefined) {
  const digits = (taxNumber ?? "").replace(/\D/g, "");
  if (digits.length !== 11) return {};
  return { taxpayerId: digits.slice(0, 8), vatCode: digits.slice(8, 9), countyCode: digits.slice(9) };
}

function navParty(party: Party): NavParty {
  return {
    name: party.name,
    ...splitTaxNumber(party.taxNumber),
    postalCode: party.postcode,
    city: party.city,
    address: party.address,
    bankAccount: party.bankAccount,
  };
}

const PAYMENT = { card: "CARD", transfer: "TRANSFER", cash: "CASH", other: "OTHER" } as const;

/**
 * NAV's names for the common Hungarian units; anything else is reported as
 * OWN with the unit written out, which NAV accepts for any unit.
 */
const UNITS: Record<string, string> = {
  db: "PIECE",
  darab: "PIECE",
  kg: "KILOGRAM",
  t: "TON",
  tonna: "TON",
  kwh: "KWH",
  nap: "DAY",
  óra: "HOUR",
  perc: "MINUTE",
  hó: "MONTH",
  hónap: "MONTH",
  l: "LITER",
  liter: "LITER",
  km: "KILOMETER",
  m3: "CUBIC_METER",
  "m³": "CUBIC_METER",
  m: "METER",
  fm: "LINEAR_METER",
  karton: "CARTON",
  csomag: "PACK",
};

export function unitOf(unit: string): string {
  return UNITS[unit.trim().toLowerCase()] ?? "OWN";
}

function navLines(
  lines: readonly InvoiceLine[],
  continueFrom?: number,
): NavLine[] {
  return lines.map((line, index) => ({
    description: line.description,
    quantity: line.quantity,
    unitOfMeasure: unitOf(line.unit),
    unitOfMeasureOwn: unitOf(line.unit) === "OWN" ? line.unit : undefined,
    unitPriceNet: line.lineNet / line.quantity,
    netAmount: line.lineNet,
    vatAmount: line.lineVat,
    grossAmount: line.lineGross,
    vatRate: line.vatRate,
    vatExemption: line.vatExemption,
    // A storno's lines continue the original's numbering in the chain
    // (specification 2.5.1): the first reversing line of a two-line invoice
    // is the chain's line 3.
    ...(continueFrom === undefined
      ? {}
      : {
          lineNumber: index + 1,
          modifies: { lineNumberReference: continueFrom + index + 1, operation: "CREATE" as const },
        }),
  }));
}

type InvoiceRow = typeof invoices.$inferSelect;


export async function navInvoiceOf(db: Database, row: InvoiceRow): Promise<NavInvoice> {
  const seller = row.sellerSnapshot as Party;
  const buyer = row.buyerSnapshot as Party;
  const lines = row.lines as InvoiceLine[];

  let reverses: string | undefined;
  let continueFrom: number | undefined;
  if (row.type === "storno") {
    if (!row.originalInvoiceId) throw new Error(`storno ${row.invoiceNumber} names no original`);
    const [original] = await db.select().from(invoices).where(eq(invoices.id, row.originalInvoiceId));
    if (!original) throw new Error(`the original of storno ${row.invoiceNumber} is missing`);
    reverses = original.invoiceNumber;
    continueFrom = (original.lines as InvoiceLine[]).length;
  }

  // One summary row per rate, and per exemption case and reason: NAV wants
  // AAM, TAM and reverse-charge sums apart, like different rates.
  const rates = new Map<string, NavVatSummary>();
  for (const line of lines) {
    const key = line.vatExemption ? `${line.vatExemption.case}:${line.vatExemption.reason}` : String(line.vatRate);
    const rate = rates.get(key) ?? { vatRate: line.vatRate, vatExemption: line.vatExemption, net: 0, vat: 0 };
    rate.net += line.lineNet;
    rate.vat += line.lineVat;
    rates.set(key, rate);
  }

  return {
    invoiceNumber: row.invoiceNumber,
    issueDate: row.issueDate,
    deliveryDate: row.fulfilmentDate,
    paymentDate: row.dueDate,
    paymentMethod: PAYMENT[row.paymentMethod],
    currency: row.currency,
    supplier: navParty(seller),
    customer: navParty(buyer),
    // A buyer with a tax number is a business; anyone else bought privately,
    // and NAV refuses to be told who they are.
    customerVatStatus: buyer.taxNumber ? "DOMESTIC" : "PRIVATE_PERSON",
    lines: navLines(lines, continueFrom),
    vatSummary: [...rates.values()],
    totalNet: row.totalNet,
    totalVat: row.totalVat,
    totalGross: row.totalGross,
    reverses,
    modificationIndex: reverses ? 1 : undefined,
  };
}

export type ReportOutcome = {
  transactionId?: string;
  /** done, warning or error, as nav_submissions records it. */
  status: "done" | "warning" | "error" | "sent";
  messages: string[];
  /** NAV's code for a refusal, when it gave one. */
  finalCode?: string;
};

/**
 * Sends one invoice and waits a little for NAV's verdict. A NAV that is slow
 * or down never blocks anything: the row is left as sent or error, and the
 * reconciliation job picks it up again.
 */
export async function reportInvoice(
  db: Database,
  client: NavClient,
  invoiceId: string,
  options: { pollAttempts?: number; pollIntervalMs?: number; attempt?: number } = {},
): Promise<ReportOutcome> {
  const [row] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!row) throw new Error(`no invoice with id ${invoiceId}`);

  const navInvoice = await navInvoiceOf(db, row);
  const operation = row.type === "storno" ? "STORNO" : "CREATE";
  const requestXml = invoiceDataXml(navInvoice);

  const [submission] = await db
    .insert(navSubmissions)
    .values({
      invoiceId,
      status: "pending",
      attemptCount: options.attempt ?? 1,
      requestXml,
      lastAttemptAt: new Date(),
    })
    .returning();

  const record = (values: Partial<typeof navSubmissions.$inferInsert>) =>
    db.update(navSubmissions).set(values).where(eq(navSubmissions.id, submission!.id));

  let transactionId: string;
  try {
    ({ transactionId } = await client.manageInvoice([{ operation, invoice: navInvoice }]));
  } catch (error) {
    const navError = error instanceof NavError ? error : undefined;
    await record({
      status: "error",
      errorCode: navError?.errorCode ?? "UNREACHABLE",
      errorMessage: error instanceof Error ? error.message : String(error),
      responseXml: navError?.body,
    });
    return {
      status: "error",
      messages: [error instanceof Error ? error.message : String(error), ...(navError?.validations ?? [])],
      finalCode: navError?.errorCode,
    };
  }

  await record({ status: "sent", transactionId });

  const attempts = options.pollAttempts ?? 10;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs ?? 2500));
    const verdict = await client.queryTransactionStatus(transactionId);
    if (!verdict.finished) continue;
    const recorded = await recordVerdict(db, submission!.id, verdict);
    return {
      transactionId,
      ...recorded,
      messages: [...recorded.messages],
      finalCode: recorded.status === "error" ? verdict.invoices[0]!.status : undefined,
    };
  }

  return { transactionId, status: "sent", messages: ["NAV has not decided yet"] };
}

async function recordVerdict(db: Database, submissionId: string, verdict: TransactionStatus) {
  const one = verdict.invoices[0]!;
  const warned = one.messages.some((message) => message.startsWith("WARN"));
  const status = one.status === "DONE" ? (warned ? "warning" : "done") : "error";
  await db
    .update(navSubmissions)
    .set({
      status,
      responseXml: JSON.stringify(verdict),
      errorCode: status === "error" ? one.status : null,
      errorMessage: one.messages.join("\n") || null,
      completedAt: new Date(),
    })
    .where(eq(navSubmissions.id, submissionId));
  return { status, messages: one.messages } as const;
}

export type ReportState =
  | { state: "accepted"; status: "done" | "warning" }
  /** On its way, or waiting for the next try. */
  | { state: "waiting"; reason: string }
  /** NAV will not take the invoice as it is: a person has to look. */
  | { state: "rejected"; messages: string[] };

/**
 * NAV's answers that are about the invoice itself, which sending it again
 * will not change: ABORTED is its verdict on the data, INVALID_REQUEST a
 * request it could not even read. Everything else — NAV down, a timeout, a
 * refused login — is tried again.
 */
const FINAL_ERRORS = new Set(["ABORTED", "INVALID_REQUEST"]);

/** Minutes to wait before the second, third, fourth try; hourly after that. */
const RETRY_MINUTES = [5, 15, 45, 60];

function retryAfterMinutes(attemptsSoFar: number): number {
  return RETRY_MINUTES[Math.min(attemptsSoFar, RETRY_MINUTES.length) - 1] ?? 60;
}

/**
 * Takes an invoice's report one step further from wherever it was left:
 * never sent, sent and awaiting NAV's verdict, or failed. Safe to call as
 * often as the checker likes; it sends again only when the wait is over, and
 * before sending again it asks NAV whether an earlier attempt arrived after
 * all — a request that timed out on our side may well have landed on theirs,
 * and a second CREATE for the same number would be refused as a duplicate.
 */
export async function advanceReport(
  db: Database,
  client: NavClient,
  invoiceId: string,
  options: { now?: Date; pollIntervalMs?: number } = {},
): Promise<ReportState> {
  const now = options.now ?? new Date();
  const poll = { pollIntervalMs: options.pollIntervalMs };
  const history = await db
    .select()
    .from(navSubmissions)
    .where(eq(navSubmissions.invoiceId, invoiceId))
    .orderBy(desc(navSubmissions.createdAt));
  const latest = history[0];

  const settle = (outcome: ReportOutcome): ReportState =>
    outcome.status === "done" || outcome.status === "warning"
      ? { state: "accepted", status: outcome.status }
      : outcome.status === "sent"
        ? { state: "waiting", reason: "NAV is still processing it" }
        : { state: "waiting", reason: outcome.messages.join("; ") };

  if (!latest) return settleFinal(await reportInvoice(db, client, invoiceId, poll));

  if (latest.status === "done" || latest.status === "warning") {
    return { state: "accepted", status: latest.status };
  }

  if (latest.status === "sent" && latest.transactionId) {
    const verdict = await client.queryTransactionStatus(latest.transactionId);
    if (!verdict.finished) return { state: "waiting", reason: "NAV is still processing it" };
    const recorded = await recordVerdict(db, latest.id, verdict);
    return recorded.status === "error"
      ? { state: "rejected", messages: recorded.messages }
      : { state: "accepted", status: recorded.status };
  }

  if (latest.status === "error" && latest.errorCode && FINAL_ERRORS.has(latest.errorCode)) {
    return { state: "rejected", messages: (latest.errorMessage ?? latest.errorCode).split("\n") };
  }

  // Never answered: an error on the way, or a send cut off halfway (pending).
  const lastTry = latest.lastAttemptAt ?? latest.createdAt;
  const due = new Date(lastTry.getTime() + retryAfterMinutes(history.length) * 60_000);
  if (now < due) {
    return { state: "waiting", reason: `next try at ${due.toISOString()} (${latest.errorCode ?? latest.status})` };
  }

  const [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
  const stored = await client.queryInvoiceData(invoice!.invoiceNumber);
  if (stored?.transactionId) {
    const verdict = await client.queryTransactionStatus(stored.transactionId);
    await db
      .update(navSubmissions)
      .set({ transactionId: stored.transactionId, status: "sent" })
      .where(eq(navSubmissions.id, latest.id));
    if (verdict.finished) {
      const recorded = await recordVerdict(db, latest.id, verdict);
      if (recorded.status !== "error") return { state: "accepted", status: recorded.status };
    }
    return { state: "waiting", reason: "found at NAV; waiting for its verdict" };
  }

  return settleFinal(await reportInvoice(db, client, invoiceId, { ...poll, attempt: history.length + 1 }));

  function settleFinal(outcome: ReportOutcome): ReportState {
    if (outcome.status === "error" && isFinal(outcome)) return { state: "rejected", messages: outcome.messages };
    return settle(outcome);
  }
}

function isFinal(outcome: ReportOutcome): boolean {
  return outcome.finalCode !== undefined && FINAL_ERRORS.has(outcome.finalCode);
}
