/**
 * Invoice dates are calendar days in Hungary. The server keeps UTC; a payment
 * at half past midnight in Budapest is still the evening before in UTC, and
 * an invoice dated that evening would be a day out — on New Year's night, a
 * year out in its number.
 */

const ZONE = "Europe/Budapest";

/** yyyy-mm-dd in Budapest. */
export function budapestDate(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ZONE }).format(at);
}

export function budapestHour(at: Date): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, hour: "2-digit", hourCycle: "h23" }).format(at));
}

/** The Budapest calendar day as a UTC midnight, which is how the invoicing library takes a date. */
export function dayOf(at: Date): Date {
  return new Date(`${budapestDate(at)}T00:00:00Z`);
}

export function day(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60_000);
}

/** The month before the one a moment falls in, in Hungary: 2026-09. */
export function previousMonth(at: Date): string {
  const [year, month] = budapestDate(at).split("-").map(Number) as [number, number];
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
}

/** 2026-09 → its first day and the next month's first day. */
export function monthBounds(month: string): { from: string; until: string } {
  const [year, number] = month.split("-").map(Number) as [number, number];
  const next = number === 12 ? `${year + 1}-01` : `${year}-${String(number + 1).padStart(2, "0")}`;
  return { from: `${month}-01`, until: `${next}-01` };
}
