import { and, asc, gte, lte } from "drizzle-orm";
import { zipSync } from "fflate";
import { invoiceDataXml } from "@szamlazo/nav";
import { parseInvoiceNumber } from "@szamlazo/invoicing";
import type { Database } from "./db/client.js";
import { invoices } from "./db/schema.js";
import { navInvoiceOf } from "./nav-reporting.js";

/**
 * The tax authority's inspection export (adóhatósági ellenőrzési
 * adatszolgáltatás, 23/2014. (VI. 30.) NGM rendelet): every invoice issued in
 * a period, or in a range of numbers, handed over when NAV asks for it.
 *
 * The regulation allows the data structure of the Online Számla reporting
 * instead of its own szamla.xsd, so each invoice is exported as the very
 * InvoiceData document that is reported to NAV, one XML file per invoice,
 * named after its number, in a zip.
 */

export type ExportSelection = { issuedFrom: string; issuedTo: string } | { firstNumber: string; lastNumber: string };

export async function exportInvoices(
  db: Database,
  selection: ExportSelection,
): Promise<{ zip: Uint8Array; invoiceNumbers: string[] }> {
  let rows: (typeof invoices.$inferSelect)[];

  if ("issuedFrom" in selection) {
    rows = await db
      .select()
      .from(invoices)
      .where(and(gte(invoices.issueDate, selection.issuedFrom), lte(invoices.issueDate, selection.issuedTo)))
      .orderBy(asc(invoices.invoiceNumber));
  } else {
    const first = parseInvoiceNumber(selection.firstNumber);
    const last = parseInvoiceNumber(selection.lastNumber);
    if (!first || !last || first.prefix !== last.prefix) {
      throw new Error(`not a range of invoice numbers: ${selection.firstNumber} to ${selection.lastNumber}`);
    }
    const key = (parsed: { year: number; sequence: number }) => parsed.year * 1e7 + parsed.sequence;
    rows = (await db.select().from(invoices).orderBy(asc(invoices.invoiceNumber))).filter((row) => {
      const parsed = parseInvoiceNumber(row.invoiceNumber);
      return parsed?.prefix === first.prefix && key(parsed) >= key(first) && key(parsed) <= key(last);
    });
  }

  const files: Record<string, Uint8Array> = {};
  for (const row of rows) {
    const xml = invoiceDataXml(await navInvoiceOf(db, row));
    files[`${row.invoiceNumber.replaceAll("/", "-")}.xml`] = new TextEncoder().encode(xml);
  }
  return { zip: zipSync(files), invoiceNumbers: rows.map((row) => row.invoiceNumber) };
}
