import type { PaymentMethod } from "./types.js";

/**
 * Formatting for what is printed on the invoice. Written out rather than taken
 * from Intl so that the same invoice renders identically on a laptop, on the
 * server and in ten years, whatever locale data is installed.
 *
 * A date on an invoice is a calendar day, not a moment, so every date is read
 * in UTC. Give it `new Date("2026-09-22")` or `new Date(Date.UTC(...))`, never
 * a date built from local parts, or an invoice issued late in the evening in
 * Budapest would be dated the day before.
 */

export function formatDateHu(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}.${month}.${day}.`;
}

export function yearOf(date: Date): number {
  return date.getUTCFullYear();
}

/**
 * Hungarian groups thousands with a thin space, but only from five digits up:
 * 3490 is written without one, 10 000 with it. That is the rule Intl applies
 * for hu-HU, written out here so the library needs no locale data, and so the
 * invoice and the program around it print a number the same way.
 */
export function formatAmount(value: number): string {
  const negative = value < 0;
  const digits = String(Math.abs(value));
  let grouped = digits;
  if (digits.length > 4) {
    grouped = "";
    for (let index = 0; index < digits.length; index++) {
      if (index > 0 && (digits.length - index) % 3 === 0) grouped += " ";
      grouped += digits[index];
    }
  }
  return negative ? `−${grouped}` : grouped;
}

/**
 * A unit price is the line's net divided by the quantity, which is not always
 * a whole forint: two bags at 2100 gross net to 3307, so the unit is 1653,50.
 * Printing it rounded would invite the reader to multiply it out and find a
 * forint missing, so up to two decimals are shown, with the comma Hungarian
 * uses. The amounts that are money — the lines and the totals — stay whole.
 */
export function formatUnitAmount(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  if (Number.isInteger(rounded)) return formatAmount(rounded);
  const negative = rounded < 0;
  const whole = Math.floor(Math.abs(rounded));
  const cents = Math.round((Math.abs(rounded) - whole) * 100);
  const text = `${formatAmount(whole)},${String(cents).padStart(2, "0")}`;
  return negative ? `\u2212${text}` : text;
}

export function formatUnitMoney(value: number, currency: string): string {
  return currency === "HUF"
    ? `${formatUnitAmount(value)} Ft`
    : `${formatUnitAmount(value)} ${currency}`;
}

export function formatMoney(value: number, currency: string): string {
  return currency === "HUF" ? `${formatAmount(value)} Ft` : `${formatAmount(value)} ${currency}`;
}

const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  card: "Bankkártya",
  transfer: "Átutalás",
  cash: "Készpénz",
  other: "Egyéb",
};

export function paymentMethodLabel(method: PaymentMethod): string {
  return PAYMENT_LABELS[method];
}

/** 12345678241 and 12345678-2-41 are the same number; this prints the second. */
export function formatTaxNumber(taxNumber: string): string {
  const digits = taxNumber.replace(/\D/g, "");
  if (digits.length !== 11) return taxNumber;
  return `${digits.slice(0, 8)}-${digits.slice(8, 9)}-${digits.slice(9)}`;
}
