/**
 * Invoice numbers are the one thing in an invoicing program that cannot be
 * repaired afterwards: a gap or a duplicate is a problem with the tax
 * authority, not a bug to patch. So the sequence lives outside this library,
 * in whatever can promise atomicity — a locked database row — and this file
 * only describes the shape of a number and the port that hands one out.
 */

export type NumberFormat = {
  /** Letters in front of the year: "SZ" gives SZ2026/00001. */
  prefix: string;
  /** How many digits the counter is padded to. */
  digits?: number;
};

const DEFAULT_DIGITS = 5;

export function formatInvoiceNumber(
  sequence: number,
  year: number,
  { prefix, digits = DEFAULT_DIGITS }: NumberFormat,
): string {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new RangeError(`sequence must be a positive whole number, got ${sequence}`);
  }
  if (!Number.isInteger(year) || year < 2000 || year > 9999) {
    throw new RangeError(`year must be a four-digit year, got ${year}`);
  }
  if (!/^[A-Z]{1,8}$/.test(prefix)) {
    throw new RangeError(`prefix must be one to eight capital letters, got "${prefix}"`);
  }
  return `${prefix}${year}/${String(sequence).padStart(digits, "0")}`;
}

/** Reads a number back, for checking a sequence or sorting old invoices. */
export function parseInvoiceNumber(
  invoiceNumber: string,
): { prefix: string; year: number; sequence: number } | null {
  const found = invoiceNumber.match(/^([A-Z]{1,8})(\d{4})\/(\d+)$/);
  if (!found) return null;
  return {
    prefix: found[1]!,
    year: Number(found[2]),
    sequence: Number(found[3]),
  };
}

/**
 * Hands out the next number in the sequence. The implementation must be
 * atomic against every other caller, and must consume the number in the same
 * transaction that stores the invoice, so that a failure later gives the
 * number back. An in-memory implementation is fine for tests and useless in
 * production.
 */
export type SequenceSource = {
  next(): Promise<number>;
};

/**
 * A counter in memory, for tests and for trying the library out. It is safe
 * within one process because JavaScript runs one thing at a time, and unsafe
 * across two, which is exactly why production uses the database instead.
 */
export function inMemorySequence(from = 0): SequenceSource {
  let last = from;
  return {
    next: async () => {
      last += 1;
      return last;
    },
  };
}
