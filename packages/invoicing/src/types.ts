import type { Forint } from "./money.js";

/**
 * The seller, as it must appear on a Hungarian invoice: name, address and tax
 * number. Everything is a plain string, because an invoice records what was
 * true when it was issued, not a reference to a record that can change.
 */
export type Party = {
  name: string;
  /** Street address, one line: "Fő utca 1." */
  address: string;
  postcode: string;
  city: string;
  countryCode?: string;
  /** 11 characters with or without dashes. Required for a company buyer. */
  taxNumber?: string;
  /** Sole traders have this instead of a company registration number. */
  registrationNumber?: string;
  email?: string;
  phone?: string;
  bankAccount?: string;
  bankName?: string;
  /**
   * What to print under the name, in this order. Sellers differ on what
   * belongs on an invoice and in what order; when this is left out the
   * details above are printed in the usual one. The name is always first.
   */
  lines?: readonly string[];
};

export type PaymentMethod = "card" | "transfer" | "cash" | "other";

export type InvoiceType = "normal" | "storno";

/**
 * Why a line carries no VAT. The case is what NAV is told; the reason is the
 * legal reference the invoice must print (Áfa tv. 169. § m) and n)).
 *
 * - AAM: alanyi adómentes, the seller is exempt as a person (Áfa tv. 187. §)
 * - TAM: tárgyi adómentes, the supply is exempt (Áfa tv. 85.–86. §)
 * - ATK: outside the scope of the VAT act altogether
 * - REVERSE_CHARGE: belföldi fordított adózás (Áfa tv. 142. §); the buyer
 *   pays the VAT, so the invoice shows none
 */
export type VatExemptionCase = "AAM" | "TAM" | "ATK" | "REVERSE_CHARGE";

export type VatExemption = {
  case: VatExemptionCase;
  /** Printed on the invoice and reported to NAV; at most 200 characters. */
  reason: string;
};

/** What is being billed, before the amounts are worked out. */
export type LineInput = {
  description: string;
  quantity: number;
  /** "db", "liter", "óra" — printed as given. */
  unit: string;
  unitPriceGross: Forint;
  /** Whole percentage. 27 for the standard Hungarian rate; 0 with vatExemption. */
  vatRate: number;
  /** Required when vatRate is 0, and only then. */
  vatExemption?: VatExemption;
};

/** A line with its amounts settled. These are what the invoice states. */
export type InvoiceLine = LineInput & {
  lineNet: Forint;
  lineVat: Forint;
  lineGross: Forint;
};

/**
 * VAT summed per rate, which is what an invoice and NAV both want. Lines
 * without VAT are grouped by their exemption case, because each case is a
 * separate row for NAV and a separate note on the invoice.
 */
export type VatSummaryRow = {
  vatRate: number;
  vatExemption?: VatExemption;
  net: Forint;
  vat: Forint;
  gross: Forint;
};

export type IssueInput = {
  seller: Party;
  buyer: Party;
  lines: readonly LineInput[];
  /** Day of issue. */
  issueDate: Date;
  /** Day the sale was fulfilled; for a prepaid order, the day paid. */
  fulfilmentDate: Date;
  /** When the money is due. Same day for a prepaid order. */
  dueDate: Date;
  paymentMethod: PaymentMethod;
  currency?: string;
  /** Free text under the lines: thanks, a reference, terms. */
  note?: string;
  /** The order this invoice bills, printed as a reference. */
  orderNumber?: string;
};

export type Invoice = {
  invoiceNumber: string;
  type: InvoiceType;
  /** Set on a storno: the number of the invoice being reversed. */
  originalInvoiceNumber?: string;
  seller: Party;
  buyer: Party;
  lines: readonly InvoiceLine[];
  vatSummary: readonly VatSummaryRow[];
  totalNet: Forint;
  totalVat: Forint;
  totalGross: Forint;
  issueDate: Date;
  fulfilmentDate: Date;
  dueDate: Date;
  paymentMethod: PaymentMethod;
  currency: string;
  note?: string;
  orderNumber?: string;
};
