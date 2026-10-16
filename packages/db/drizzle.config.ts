import { defineConfig } from 'drizzle-kit';

// Used only by `drizzle-kit generate` (no database connection). Migrations are applied by
// `runMigrations` (src/migrate.ts), never by drizzle-kit.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
});
