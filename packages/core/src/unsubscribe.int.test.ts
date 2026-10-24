import { ClientIdSchema, TenantIdSchema, type ClientId, type TenantId } from '@pepper/contracts';
import { findClient, insertClient, listAuditEntries, withTenant, type Database } from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ManualClock } from './clock.js';
import { UnsubscribeLinkInvalidError } from './errors.js';
import { outboxKeyFrom } from './outbox.js';
import { createBusiness } from './services/business.js';
import { describeUnsubscribe, unsubscribe } from './services/unsubscribe.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';
import { unsubscribeKeyFrom, unsubscribeToken } from './unsubscribe-token.js';

// One-click unsubscribe against real Postgres (S36, ADR-0040): no sign-in, the link checked
// first, the page read-only, the POST idempotent, an audit entry without the address.

let database: TestDatabase;
let db: Database;
let tenantId: TenantId;
let sara: ClientId;

const key = unsubscribeKeyFrom(outboxKeyFrom('an-integration-test-outbox-secret-32+'));
const clock = new ManualClock('2026-11-02T15:00:00.000Z');

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  const owner = await insertUser(db, 'Ana');
  tenantId = TenantIdSchema.parse(
    (
      await createBusiness(db, owner, {
        name: 'Juniper Hair Studio',
        slug: 'juniper-unsubscribe',
        timeZone: 'America/New_York',
      })
    ).id,
  );
  sara = ClientIdSchema.parse(
    (
      await withTenant(db, tenantId, (tx) =>
        insertClient(tx, {
          name: 'Sara Kim',
          email: 'sara@example.test',
          phone: null,
          source: 'team',
        }),
      )
    ).id,
  );
});

afterAll(async () => {
  await database.stop();
});

describe('unsubscribe', () => {
  it('shows the business without changing anything, then unsubscribes once', async () => {
    const token = unsubscribeToken(key, { tenantId, clientId: sara });
    expect(await describeUnsubscribe(db, key, token)).toEqual({
      businessName: 'Juniper Hair Studio',
      unsubscribed: false,
    });
    expect(
      (await withTenant(db, tenantId, (tx) => findClient(tx, sara)))?.emailOptOutAt,
    ).toBeNull();

    expect(await unsubscribe(db, key, token, { clock })).toEqual({
      businessName: 'Juniper Hair Studio',
      unsubscribed: true,
    });
    expect(
      await unsubscribe(db, key, token, { clock: new ManualClock('2026-12-01T00:00:00Z') }),
    ).toEqual({
      businessName: 'Juniper Hair Studio',
      unsubscribed: true,
    });
    expect((await withTenant(db, tenantId, (tx) => findClient(tx, sara)))?.emailOptOutAt).toEqual(
      clock.now(),
    );
    expect((await describeUnsubscribe(db, key, token)).unsubscribed).toBe(true);
    const entries = (
      await withTenant(db, tenantId, (tx) => listAuditEntries(tx, { limit: 50 }))
    ).filter((entry) => entry.action === 'client.email_opted_out');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actor).toEqual({ kind: 'system', userId: null });
    expect(JSON.stringify(entries)).not.toContain('sara@');
  });

  it('refuses a link it did not sign, and one for a business that is gone', async () => {
    const forged = unsubscribeToken(unsubscribeKeyFrom(outboxKeyFrom('x'.repeat(40))), {
      tenantId,
      clientId: sara,
    });
    await expect(unsubscribe(db, key, forged)).rejects.toThrow(UnsubscribeLinkInvalidError);
    await expect(describeUnsubscribe(db, key, 'nonsense')).rejects.toThrow(
      UnsubscribeLinkInvalidError,
    );
    const gone = unsubscribeToken(key, {
      tenantId: TenantIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f700009'),
      clientId: sara,
    });
    await expect(unsubscribe(db, key, gone)).rejects.toThrow(UnsubscribeLinkInvalidError);
  });

  it('a client deleted since reads as unsubscribed', async () => {
    const token = unsubscribeToken(key, {
      tenantId,
      clientId: ClientIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f700010'),
    });
    expect(await describeUnsubscribe(db, key, token)).toMatchObject({ unsubscribed: true });
    expect(await unsubscribe(db, key, token)).toMatchObject({ unsubscribed: true });
  });
});
