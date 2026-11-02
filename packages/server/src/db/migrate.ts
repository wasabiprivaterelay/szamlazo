import { migrate as runMigrations } from "drizzle-orm/postgres-js/migrator";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDatabase } from "./client.js";

/**
 * The migrations folder: beside the package when run from source, and beside
 * the bundle in dist/ (the Dockerfile copies it there). Whichever exists.
 */
export function migrationsFolder(): string {
  for (const candidate of ["../../migrations", "../migrations"]) {
    const path = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(path)) return path;
  }
  throw new Error("the migrations folder is missing");
}

/**
 * Applies the migrations the database has not seen. Drizzle records what it
 * applied, so running it again does nothing; the server runs it at start-up.
 */
export async function migrate(url: string, folder: string = migrationsFolder()): Promise<void> {
  const { db, close } = createDatabase(url, { max: 1 });
  try {
    await runMigrations(db, { migrationsFolder: folder });
  } finally {
    await close();
  }
}
