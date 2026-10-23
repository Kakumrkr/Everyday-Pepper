// `node dist/evals/eval-db.js <file>`: starts a migrated throwaway Postgres in Docker, writes its
// app-login URL to <file> and stays up until stopped (S27). Record real-model evals against it
// with `EVAL_DATABASE_URL=$(cat <file>)`: loading Testcontainers inside the recorder replaces
// Node's fetch dispatcher, so behind a proxy (`NODE_USE_ENV_PROXY=1`) the model could not be
// reached. Runs share the database (each world has its own business).
import { writeFileSync } from 'node:fs';
import { prepareDatabase } from '@pepper/db';
import { postgresUrlAs, startPostgres } from '@pepper/testing';

const out = process.argv[2];
if (out === undefined) {
  process.stderr.write('usage: node dist/evals/eval-db.js <file for the url>\n');
  process.exit(2);
}
const postgres = await startPostgres();
const appUrl = postgresUrlAs(postgres.url, 'pepper_service', 'eval-runner-password');
await prepareDatabase(postgres.url, appUrl);
writeFileSync(out, appUrl);
process.stdout.write('ready\n');
const stop = () => {
  void postgres.stop().finally(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
// Nothing else keeps the process alive: a timer does, until a signal stops the database.
setInterval(() => undefined, 1 << 30);
