import { defineConfig } from "drizzle-kit";

// `npm run db:generate` writes a new migration to netlify/database/migrations.
// Netlify applies them before each production deploy's server starts.
export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema.ts",
  out: "netlify/database/migrations",
});
