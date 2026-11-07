// `pnpm --filter @pepper/db operator grant <email> "<who and why>"`, `… revoke <email>` and
// `… list` (S59.2, ADR-0062): the only way to make an account a Pepper operator. Runs as
// MIGRATION_DATABASE_URL; the services' role can't read or change the grants.
import { z } from 'zod';
import { grantOperator, listOperators, revokeOperator } from './operators.js';

const EnvSchema = z.object({ MIGRATION_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }) });
const env = EnvSchema.safeParse(process.env);
if (!env.success) {
  process.stderr.write('operator: MIGRATION_DATABASE_URL is missing or invalid\n');
  process.exit(1);
}
const url = env.data.MIGRATION_DATABASE_URL;
const [command, email, note] = process.argv.slice(2);

try {
  if (command === 'grant' && email !== undefined && note !== undefined) {
    const result = await grantOperator(url, { email, note });
    process.stdout.write(
      result === 'granted' ? 'operator: granted\n' : 'operator: no account has that email\n',
    );
    if (result !== 'granted') process.exit(1);
  } else if (command === 'revoke' && email !== undefined) {
    const result = await revokeOperator(url, email);
    process.stdout.write(
      result === 'revoked' ? 'operator: revoked\n' : 'operator: not an operator\n',
    );
  } else if (command === 'list') {
    for (const grant of await listOperators(url)) {
      process.stdout.write(`${grant.email}\t${grant.grantedAt.toISOString()}\t${grant.note}\n`);
    }
  } else {
    process.stderr.write(
      'usage: operator grant <email> "<who and why>" | operator revoke <email> | operator list\n',
    );
    process.exit(2);
  }
} catch (error) {
  process.stderr.write(
    `operator: failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exit(1);
}
