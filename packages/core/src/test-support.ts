// Integration-test helpers (not built into dist).
import { UserIdSchema, type UserId } from '@pepper/contracts';
import {
  createDatabase,
  newId,
  prepareDatabase,
  users,
  type Database,
  type DatabaseHandle,
} from '@pepper/db';
import { postgresUrlAs, startPostgres } from '@pepper/testing';
import type { InboundEmail } from './inbound-email.js';

export interface TestDatabase {
  migrationUrl: string;
  /** A pool connected as the services' login role, as in Compose. */
  app: DatabaseHandle;
  stop(): Promise<void>;
}

/** A migrated Postgres with the services' login role provisioned. */
export async function startTestDatabase(): Promise<TestDatabase> {
  const postgres = await startPostgres();
  const appUrl = postgresUrlAs(postgres.url, 'pepper_service', 'service-test-password');
  await prepareDatabase(postgres.url, appUrl);
  const app = createDatabase({ url: appUrl, maxConnections: 8, connectionTimeoutMs: 30_000 });
  return {
    migrationUrl: postgres.url,
    app,
    stop: async () => {
      await app.close();
      await postgres.stop();
    },
  };
}

/** Inserts a user directly (Better Auth creates them in the app); returns its id. */
export async function insertUser(db: Database, name: string, email?: string): Promise<UserId> {
  const id = newId();
  await db.insert(users).values({ id, name, email: email ?? `user-${id}@example.test` });
  return UserIdSchema.parse(id);
}

/** An inbound email fixture (S59.3), with what the core tests check and fill in. */
export interface InboundFixture {
  description: string;
  email: InboundEmail;
  /** The words that should land, when it lands. */
  expected: string | null;
}

/**
 * Loads `src/fixtures/inbound-email/<name>.json`, filling in `{{from}}`, `{{fromDomain}}`,
 * `{{reply}}` (the request's signed address), `{{root}}` (its root id) and `{{ref}}`.
 */
export async function loadInboundFixture(
  name: string,
  vars: { from: string; reply: string; root: string; ref: string },
): Promise<InboundFixture> {
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(
    new URL(`./fixtures/inbound-email/${name}.json`, import.meta.url),
    'utf8',
  );
  const filled = raw
    .replaceAll('{{fromDomain}}', vars.from.slice(vars.from.indexOf('@') + 1))
    .replaceAll('{{from}}', vars.from)
    .replaceAll('{{reply}}', vars.reply)
    .replaceAll('{{root}}', vars.root)
    .replaceAll('{{ref}}', vars.ref);
  const data = JSON.parse(filled) as {
    description: string;
    from: string;
    recipients: string[];
    subject: string;
    text: string | null;
    html: string | null;
    headers: { name: string; value: string }[];
    inReplyTo: string | null;
    references: string[];
    attachments: {
      filename: string | null;
      contentType: string | null;
      size: number | null;
      inline: boolean;
      base64: string;
    }[];
    size: number | null;
    expected: string | null;
  };
  return {
    description: data.description,
    expected: data.expected,
    email: {
      from: data.from.toLowerCase(),
      recipients: data.recipients.map((address) => address.toLowerCase()),
      subject: data.subject,
      text: data.text,
      html: data.html,
      headers: data.headers,
      inReplyTo: data.inReplyTo,
      references: data.references,
      size: data.size,
      attachments: data.attachments.map((attachment) => ({
        filename: attachment.filename,
        contentType: attachment.contentType,
        size: attachment.size,
        inline: attachment.inline,
        content: () => Promise.resolve(new Uint8Array(Buffer.from(attachment.base64, 'base64'))),
      })),
    },
  };
}

/** Sets whether a user has a second factor (Better Auth sets it in the app). */
export async function setTwoFactor(db: Database, userId: UserId, on: boolean): Promise<void> {
  // Test-only, from validated values: a uuid and a boolean.
  const id = UserIdSchema.parse(userId);
  await db.execute(
    `UPDATE users SET two_factor_enabled = ${on ? 'true' : 'false'} WHERE id = '${id}'`,
  );
}
