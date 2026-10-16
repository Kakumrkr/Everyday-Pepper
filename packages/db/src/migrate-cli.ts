// `pnpm --filter @floty/db migrate` and the Compose `migrate` service: applies migrations as
// MIGRATION_DATABASE_URL, then (if DATABASE_URL is set) provisions the services' login role.
import { z } from 'zod';
import { provisionAppRole, runMigrations } from './migrate.js';

const DatabaseUrl = z.url({ protocol: /^postgres(ql)?$/ });
const EnvSchema = z.object({
  MIGRATION_DATABASE_URL: DatabaseUrl,
  DATABASE_URL: DatabaseUrl.optional(),
});

const present = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== ''));
const env = EnvSchema.safeParse(present);
if (!env.success) {
  // Name the variables, never their values: they carry credentials.
  const names = [...new Set(env.error.issues.map((issue) => issue.path.join('.')))];
  process.stderr.write(`migrate: invalid environment: ${names.join(', ')}\n`);
  process.exit(1);
}

try {
  await runMigrations(env.data.MIGRATION_DATABASE_URL);
  process.stdout.write('migrate: migrations applied\n');
  if (env.data.DATABASE_URL !== undefined) {
    await provisionAppRole(env.data.MIGRATION_DATABASE_URL, env.data.DATABASE_URL);
    process.stdout.write('migrate: app login role provisioned\n');
  }
} catch (error) {
  process.stderr.write(
    `migrate: failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exit(1);
}
