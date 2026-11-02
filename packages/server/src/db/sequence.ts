import { sql } from "drizzle-orm";
import type { SequenceSource } from "@szamlazo/invoicing";
import type { Database, Transaction } from "./client.js";
import { invoiceSequence } from "./schema.js";

/**
 * The invoicing library cannot promise a gapless sequence by itself; this is
 * where the promise is kept. The single row is locked inside the caller's
 * transaction, so a second issuer waits rather than reading the same number,
 * and a transaction that fails afterwards gives the number back.
 */
export function sequenceSourceFor(tx: Transaction | Database): SequenceSource {
  return {
    next: async () => {
      const rows = await tx.execute<{ last_number: number }>(
        sql`update invoice_sequence
            set last_number = last_number + 1, updated_at = now()
            where id = (select id from invoice_sequence where id = 1 for update)
            returning last_number`,
      );
      const next = rows[0]?.last_number;
      if (next === undefined) throw new Error("invoice_sequence has no row to draw a number from");
      return next;
    },
  };
}

export async function lastInvoiceNumber(db: Database): Promise<number> {
  const [row] = await db.select().from(invoiceSequence);
  return row?.lastNumber ?? 0;
}
