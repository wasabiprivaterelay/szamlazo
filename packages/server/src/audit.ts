import type { Database, Transaction } from "./db/client.js";
import { auditLog } from "./db/schema.js";

/**
 * The activity log: who did what, when, from where, and what the machinery
 * did on its own (NAV's answers, emails). One row per event, in a table the
 * database refuses to change or delete (migration 0001), so the log is the
 * record of what happened, not a record someone could tidy up afterwards.
 *
 * Actors: `ui:<email>` for a person on the web page, the API key's name for
 * a machine, `cli` for the server's commands, `system` for the checker.
 */

export type AuditEntry = {
  /** What the event is about: invoice, session, preview, export, request. */
  entity: string;
  entityId: string;
  action: string;
  actor: string;
  details?: Record<string, unknown>;
};

/** Long texts (NAV's messages, provider errors) are cut, so one entry stays small. */
function trimmed(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!details) return undefined;
  return Object.fromEntries(
    Object.entries(details)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, typeof value === "string" && value.length > 500 ? `${value.slice(0, 500)}…` : value]),
  );
}

export async function audit(db: Database | Transaction, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({ ...entry, details: trimmed(entry.details) });
}
