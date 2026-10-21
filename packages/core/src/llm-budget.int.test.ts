import { TenantIdSchema, type TenantId } from '@pepper/contracts';
import type { Database } from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ManualClock } from './clock.js';
import { createBusiness } from './services/business.js';
import { llmBudgetState, llmTokenLimits, reserveLlmTokens, usageFor } from './services/usage.js';
import { usagePeriodOf } from './usage-period.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

// The per-business token budget against real Postgres (ADR-0030, LLM10/LLM06 unbounded
// consumption): concurrent turns never reserve past the hard limit, settling gives back what
// a call did not use, and the soft limit switches the AI to the routine model.

let database: TestDatabase;
let db: Database;
let count = 0;
const clock = new ManualClock(new Date('2026-10-21T15:00:00Z'));

async function business(): Promise<TenantId> {
  count += 1;
  const owner = await insertUser(db, 'Ana');
  const tenant = await createBusiness(db, owner, {
    name: 'Juniper Hair Studio',
    slug: `juniper-budget-${String(count)}`,
    timeZone: 'America/New_York',
  });
  return TenantIdSchema.parse(tenant.id);
}

const used = async (tenantId: TenantId) =>
  (await usageFor(db, tenantId, usagePeriodOf(clock.now()))).llm_tokens;

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

describe('reserveLlmTokens', () => {
  it('lets concurrent turns reserve only up to the hard limit', async () => {
    const tenantId = await business();
    const limits = llmTokenLimits(12_000);
    const reservations = await Promise.all(
      Array.from({ length: 40 }, () =>
        reserveLlmTokens(db, tenantId, { estimate: 1_000, limits }, clock),
      ),
    );
    expect(reservations.filter((reservation) => reservation !== null)).toHaveLength(12);
    expect(await used(tenantId)).toBe(12_000);
    expect(await llmBudgetState(db, tenantId, limits, clock)).toBe('exhausted');
  });

  it('settles to what was used, once, and reports the soft limit', async () => {
    const tenantId = await business();
    const limits = llmTokenLimits(10_000);
    const first = await reserveLlmTokens(db, tenantId, { estimate: 6_000, limits }, clock);
    expect(first?.state).toBe('ok');
    await first?.settle(1_500);
    await first?.settle(1_500);
    expect(await used(tenantId)).toBe(1_500);
    const second = await reserveLlmTokens(db, tenantId, { estimate: 7_000, limits }, clock);
    expect(second?.state).toBe('soft');
    // A failed, unbilled call gives the whole reservation back.
    await second?.settle(0);
    expect(await used(tenantId)).toBe(1_500);
    // A call that used more than its estimate counts in full, even past the hard limit.
    const third = await reserveLlmTokens(db, tenantId, { estimate: 8_000, limits }, clock);
    await third?.settle(9_000);
    expect(await used(tenantId)).toBe(10_500);
    expect(await reserveLlmTokens(db, tenantId, { estimate: 1, limits }, clock)).toBeNull();
  });

  it('keeps businesses apart', async () => {
    const full = await business();
    const other = await business();
    const limits = llmTokenLimits(1_000);
    await reserveLlmTokens(db, full, { estimate: 1_000, limits }, clock);
    expect(await reserveLlmTokens(db, full, { estimate: 1, limits }, clock)).toBeNull();
    expect(await reserveLlmTokens(db, other, { estimate: 1, limits }, clock)).not.toBeNull();
  });
});
