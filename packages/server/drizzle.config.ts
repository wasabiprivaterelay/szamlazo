import { defineConfig } from "drizzle-kit";

// Only for generating migration files from the schema: npm run db:generate
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./migrations",
});
