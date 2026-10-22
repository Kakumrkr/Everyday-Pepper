import { writeFileSync } from 'node:fs';
import { prepareDatabase } from '@pepper/db';
import { postgresUrlAs, startPostgres } from '@pepper/testing';
const pg = await startPostgres();
const appUrl = postgresUrlAs(pg.url, 'pepper_service', 'eval-runner-password');
await prepareDatabase(pg.url, appUrl);
writeFileSync(process.argv[2], appUrl);
console.log('ready');
setInterval(() => {}, 1 << 30);
