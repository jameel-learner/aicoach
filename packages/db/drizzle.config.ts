import { defineConfig } from 'drizzle-kit';

// Generates SQL migrations that wrangler applies to D1 (`wrangler d1 migrations apply`).
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './migrations',
});
