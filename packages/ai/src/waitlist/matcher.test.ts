import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MATCH_LEASE_MS,
  matchRetryDelayMs,
  runWaitlistMatch,
  WaitlistMatchGivenUpError,
  type MatcherOptions,
} from './matcher.js';

// The matcher's control flow without Postgres (S37, ADR-0041): the lease, the outcomes, the
// retries and giving up. The database, the domain and the trust layer are stand-ins here; the
// same paths against real Postgres are in `matcher.int.test.ts` and the worker's AC-W5-1 test.

const db = vi.hoisted(() => ({
  claimWaitlistMatch: vi.fn(),
  expireWaitlistOffers: vi.fn(),
  findCurrentTenant: vi.fn(),
  finishWaitlistMatch: vi.fn(),
  listMemberships: vi.fn(),
  retryWaitlistMatch: vi.fn(),
}));
const domain = vi.hoisted(() => ({ stillOfferable: vi.fn(), waitlistCandidatesIn: vi.fn() }));
const trust = vi.hoisted(() => ({ actForBusiness: vi.fn() }));

vi.mock('@pepper/db', async (actual) => ({
  ...(await actual<Record<string, unknown>>()),
  ...db,
  withTenant: (_db: unknown, _tenant: unknown, work: (tx: object) => unknown) => work({}),
}));
vi.mock('@pepper/appointments', async (actual) => ({
  ...(await actual<Record<string, unknown>>()),
  ...domain,
}));
vi.mock('@pepper/core', async (actual) => ({
  ...(await actual<Record<string, unknown>>()),
  ...trust,
}));
vi.mock('../tools/runner.js', () => ({ writeRunner: () => ({ runner: {} }) }));

const { SlotUnavailableError } = await import('@pepper/appointments');

const NOW = new Date('2026-11-02T12:00:00.000Z');
const TENANT = '0192f000-0000-7000-8000-000000000001';
const MATCH = '0192f000-0000-7000-8000-000000000002';
const OWNER = '0192f000-0000-7000-8000-000000000003';

const options: MatcherOptions = {
  clock: { now: () => NOW },
  waitlistOf: () => ({ offerFanOut: 3 }),
  autonomyOf: () => ({}),
  emails: { baseUrl: 'https://app.pepper.test', outboxKey: Buffer.alloc(32) },
};

const due = { tenantId: TENANT, matchId: MATCH } as Parameters<typeof runWaitlistMatch>[1];
const run = () => runWaitlistMatch({} as Parameters<typeof runWaitlistMatch>[0], due, options);

function claimed(attempts = 1) {
  return {
    id: MATCH,
    staffMemberId: '0192f000-0000-7000-8000-000000000004',
    startsAt: new Date('2026-11-03T20:00:00.000Z'),
    attempts,
    createdAt: new Date(NOW.getTime() - 5_000),
  };
}

const candidate = {
  entryId: '0192f000-0000-7000-8000-000000000005',
  rank: 1,
  fit: 'anyone',
  waitingSince: NOW.toISOString(),
  visits: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  db.claimWaitlistMatch.mockResolvedValue(claimed());
  db.findCurrentTenant.mockResolvedValue({ templateId: null });
  db.listMemberships.mockResolvedValue([{ role: 'owner', userId: OWNER }]);
  domain.stillOfferable.mockReturnValue(true);
  domain.waitlistCandidatesIn.mockResolvedValue([candidate]);
  trust.actForBusiness.mockResolvedValue({ kind: 'proposed' });
});

describe('runWaitlistMatch', () => {
  it('a match another worker holds is skipped', async () => {
    db.claimWaitlistMatch.mockResolvedValue(undefined);
    expect(await run()).toBe('skipped');
    expect(db.claimWaitlistMatch).toHaveBeenCalledWith(
      {},
      MATCH,
      NOW,
      new Date(NOW.getTime() + MATCH_LEASE_MS),
    );
    expect(db.finishWaitlistMatch).not.toHaveBeenCalled();
  });

  it('the dial decides: proposed at ask, offered when it ran', async () => {
    expect(await run()).toBe('proposed');
    expect(db.finishWaitlistMatch).toHaveBeenLastCalledWith({}, MATCH, 'proposed');
    expect(trust.actForBusiness.mock.calls[0]?.[3]).toMatchObject({
      payload: { matchId: MATCH, entries: [candidate] },
      idempotencyKey: `waitlist.${MATCH}`,
      untrustedContext: false,
    });
    trust.actForBusiness.mockResolvedValue({ kind: 'executed' });
    expect(await run()).toBe('offered');
  });

  it('expired offers close first; too close to the time offers nothing', async () => {
    domain.stillOfferable.mockReturnValue(false);
    expect(await run()).toBe('too_soon');
    expect(db.expireWaitlistOffers).toHaveBeenCalledWith({}, NOW, 500);
    expect(domain.waitlistCandidatesIn).not.toHaveBeenCalled();
  });

  it('nobody waiting, no owner, or the time gone meanwhile: no match', async () => {
    domain.waitlistCandidatesIn.mockResolvedValue([]);
    expect(await run()).toBe('no_match');
    db.listMemberships.mockResolvedValue([{ role: 'staff', userId: OWNER }]);
    expect(await run()).toBe('no_match');
    db.listMemberships.mockResolvedValue([{ role: 'owner', userId: OWNER }]);
    domain.waitlistCandidatesIn.mockResolvedValue([candidate]);
    trust.actForBusiness.mockRejectedValue(new SlotUnavailableError([]));
    expect(await run()).toBe('no_match');
  });

  it('a failure retries with the back-off, and the fifth gives up and throws', async () => {
    db.findCurrentTenant.mockResolvedValue(undefined);
    expect(await run()).toBe('retry');
    expect(db.retryWaitlistMatch).toHaveBeenCalledWith(
      {},
      MATCH,
      new Date(NOW.getTime() + matchRetryDelayMs(1)),
    );
    db.claimWaitlistMatch.mockResolvedValue(claimed(5));
    const givenUp = run();
    await expect(givenUp).rejects.toBeInstanceOf(WaitlistMatchGivenUpError);
    await expect(givenUp).rejects.toMatchObject({
      cause: new Error('No business in this transaction'),
    });
    expect(db.finishWaitlistMatch).toHaveBeenLastCalledWith({}, MATCH, 'failed');
  });

  it('other errors from the trust layer are failures, not "no match"', async () => {
    trust.actForBusiness.mockRejectedValue(new Error('boom'));
    expect(await run()).toBe('retry');
  });
});

describe('the matcher back-off (S37)', () => {
  it('waits 10 s, then doubles, so five attempts fit well inside AC-W5-1 retries', () => {
    expect([1, 2, 3, 4].map(matchRetryDelayMs)).toEqual([10_000, 20_000, 40_000, 80_000]);
    // A lease outlives one match (a few queries), so a second worker never runs it alongside.
    expect(MATCH_LEASE_MS).toBe(60_000);
  });
});
