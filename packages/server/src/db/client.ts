import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Database = ReturnType<typeof createDatabase>["db"];

/** What `db.transaction` hands its callback: the same queries, one connection. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * One connection pool per process. `close` lets scripts and tests exit
 * instead of hanging on an open pool. Notices (Postgres's informational
 * messages) are dropped rather than printed over the logs.
 */
export function createDatabase(url: string, options: { max?: number } = {}) {
  const sql = postgres(url, { max: options.max ?? 10, onnotice: () => undefined });
  return { db: drizzle(sql, { schema }), close: () => sql.end({ timeout: 5 }) };
}
