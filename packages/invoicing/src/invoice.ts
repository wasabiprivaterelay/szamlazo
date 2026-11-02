import { yearOf } from "./format.js";
import { lineAmounts, totalsOfLines } from "./money.js";
import { formatInvoiceNumber, type NumberFormat, type SequenceSource } from "./numbering.js";
import type { Invoice, InvoiceLine, IssueInput, Party, VatExemption, VatSummaryRow } from "./types.js";

const DEFAULT_CURRENCY = "HUF";

function requireText(field: string, value: string | undefined): string {
  const text = value?.trim();
  if (!text) throw new Error(`${field} is required on an invoice`);
  return text;
}

function checkParty(role: "seller" | "buyer", party: Party): void {
  requireText(`${role}.name`, party.name);
  requireText(`${role}.address`, party.address);
  requireText(`${role}.postcode`, party.postcode);
  requireText(`${role}.city`, party.city);
}

/** A seller must always state a tax number; a private buyer need not. */
function checkSeller(seller: Party): void {
  checkParty("seller", seller);
  requireText("seller.taxNumber", seller.taxNumber);
}

function priceLines(lines: readonly IssueInput["lines"][number][]): InvoiceLine[] {
  if (lines.length === 0) throw new Error("an invoice must have at least one line");
  return lines.map((line) => {
    requireText("line.description", line.description);
    requireText("line.unit", line.unit);
    if (line.quantity === 0) throw new Error("a line cannot have a quantity of zero");
    checkVat(line);
    return { ...line, ...lineAmounts(line) };
  });
}

const EXEMPTION_CASES: readonly string[] = ["AAM", "TAM", "ATK", "REVERSE_CHARGE"];

/** A 0% line must say why, and a line that says why must be 0%. */
function checkVat(line: IssueInput["lines"][number]): void {
  if (line.vatExemption === undefined) {
    if (line.vatRate === 0) {
      throw new Error(`"${line.description}" has 0% VAT but no vatExemption saying why (AAM, TAM, ATK or REVERSE_CHARGE)`);
    }
    return;
  }
  if (line.vatRate !== 0) {
    throw new Error(`"${line.description}" has a vatExemption, so its vatRate must be 0, not ${line.vatRate}`);
  }
  if (!EXEMPTION_CASES.includes(line.vatExemption.case)) {
    throw new Error(`vatExemption.case must be AAM, TAM, ATK or REVERSE_CHARGE, got "${line.vatExemption.case}"`);
  }
  const reason = line.vatExemption.reason?.trim() ?? "";
  if (reason === "" || reason.length > 200) {
    throw new Error(`"${line.description}": vatExemption.reason must be 1-200 characters`);
  }
}

/**
 * Rules that span lines. An alanyi adómentes seller charges no VAT on
 * anything, so AAM cannot sit beside a VAT rate; and reverse charge shifts the
 * VAT to the buyer, so the buyer must be a business with a tax number.
 */
function checkVatOfInvoice(lines: readonly InvoiceLine[], buyer: Party): void {
  const aam = lines.filter((line) => line.vatExemption?.case === "AAM").length;
  if (aam > 0 && aam < lines.length) {
    throw new Error("an alanyi adómentes (AAM) invoice cannot have lines with another VAT treatment");
  }
  if (lines.some((line) => line.vatExemption?.case === "REVERSE_CHARGE") && !buyer.taxNumber?.trim()) {
    throw new Error("reverse charge (fordított adózás) needs a buyer with a tax number");
  }
}

/** The key a line's VAT is summed under: its rate, or its exemption case. */
function vatKey(line: { vatRate: number; vatExemption?: VatExemption }): string {
  return line.vatExemption ? `${line.vatExemption.case}:${line.vatExemption.reason}` : String(line.vatRate);
}

/**
 * VAT grouped by rate. One row per rate that appears, in the order the rates
 * first appear on the invoice, because that is the order a reader expects.
 */
export function vatSummaryOf(lines: readonly InvoiceLine[]): VatSummaryRow[] {
  const rows = new Map<string, VatSummaryRow>();
  for (const line of lines) {
    const key = vatKey(line);
    const row = rows.get(key) ?? {
      vatRate: line.vatRate,
      ...(line.vatExemption ? { vatExemption: line.vatExemption } : {}),
      net: 0,
      vat: 0,
      gross: 0,
    };
    row.net += line.lineNet;
    row.vat += line.lineVat;
    row.gross += line.lineGross;
    rows.set(key, row);
  }
  return [...rows.values()];
}

/**
 * Builds the invoice: prices every line, sums the totals from those lines and
 * takes the next number from the sequence. The number is taken last, so that
 * an invoice which fails to build never consumes one.
 */
export async function issueInvoice(
  input: IssueInput,
  options: { sequence: SequenceSource; numberFormat: NumberFormat },
): Promise<Invoice> {
  checkSeller(input.seller);
  checkParty("buyer", input.buyer);

  const lines = priceLines([...input.lines]);
  checkVatOfInvoice(lines, input.buyer);
  const totals = totalsOfLines(lines);

  const sequence = await options.sequence.next();
  const invoiceNumber = formatInvoiceNumber(sequence, yearOf(input.issueDate), options.numberFormat);

  return {
    invoiceNumber,
    type: "normal",
    seller: input.seller,
    buyer: input.buyer,
    lines,
    vatSummary: vatSummaryOf(lines),
    totalNet: totals.totalNet,
    totalVat: totals.totalVat,
    totalGross: totals.totalGross,
    issueDate: input.issueDate,
    fulfilmentDate: input.fulfilmentDate,
    dueDate: input.dueDate,
    paymentMethod: input.paymentMethod,
    currency: input.currency ?? DEFAULT_CURRENCY,
    note: input.note,
    orderNumber: input.orderNumber,
  };
}

/**
 * Reverses an invoice completely: the same lines with negated quantities, so
 * every amount is the original with the sign turned round, and a reference to
 * the invoice being reversed. The parties, the dates being reversed and the
 * payment method are copied from the original, because a storno states what
 * the original stated, not what is true today; only the issue date is new.
 *
 * A storno takes its number from the same sequence as a normal invoice.
 */
export async function stornoInvoice(
  original: Invoice,
  options: {
    sequence: SequenceSource;
    numberFormat: NumberFormat;
    issueDate: Date;
    note?: string;
  },
): Promise<Invoice> {
  if (original.type === "storno") {
    throw new Error(`invoice ${original.invoiceNumber} is itself a storno and cannot be reversed`);
  }

  const lines: InvoiceLine[] = original.lines.map((line) => ({
    ...line,
    quantity: -line.quantity,
    lineNet: -line.lineNet,
    lineVat: -line.lineVat,
    lineGross: -line.lineGross,
  }));

  const sequence = await options.sequence.next();
  const invoiceNumber = formatInvoiceNumber(
    sequence,
    yearOf(options.issueDate),
    options.numberFormat,
  );

  return {
    ...original,
    invoiceNumber,
    type: "storno",
    originalInvoiceNumber: original.invoiceNumber,
    lines,
    vatSummary: vatSummaryOf(lines),
    totalNet: -original.totalNet,
    totalVat: -original.totalVat,
    totalGross: -original.totalGross,
    issueDate: options.issueDate,
    note: options.note,
  };
}
