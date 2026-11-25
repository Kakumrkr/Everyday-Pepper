// Reading connected calendars (S70, ADR-0069 §5, §7; AC-X-154, AC-X-155), including the
// token-expiry scenarios, against real Postgres with a scripted provider.
import { StaffMemberIdSchema, TenantIdSchema } from '@pepper/contracts';
import { createBusiness, ManualClock, outboxKeyFrom, type Actor } from '@pepper/core';
import {
  addMembership,
  insertStaffMember,
  listAuditEntries,
  listBusyBlocksBetween,
  withTenant,
  type Database,
} from '@pepper/db';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertUser, startTestDatabase, type TestDatabase } from './int-support.js';
import { CalendarProviderError, type AccessToken, type FreeBusyInput } from './provider.js';
import { SandboxCalendarProvider } from './sandbox.js';
import {
  completeCalendarConnect,
  readCalendar,
  readOwnCalendar,
  runDueCalendarReads,
  startCalendarConnect,
  type CalendarDeps,
} from './services.js';
import { calendarTokenKeyFrom } from './tokens.js';

const REDIRECT = 'https://app.example/more/calendar/google';
const START = new Date('2026-12-01T12:00:00Z');
const MINUTE = 60_000;
const DAY = { from: new Date('2026-12-01T00:00:00Z'), to: new Date('2026-12-02T00:00:00Z') };

let database: TestDatabase;
let db: Database;
let slugs = 0;

/** The sandbox with Google's answers scripted per call, and the calls counted. */
class Scripted extends SandboxCalendarProvider {
  refreshes = 0;
  reads: string[] = [];
  /** Busy times the next reads give; `undefined`: the sandbox's hour a day. */
  busy: { start: string; end: string }[] | undefined;
  refreshFails: CalendarProviderError | null = null;
  readFails: CalendarProviderError[] = [];

  override refresh(token: string): Promise<AccessToken> {
    this.refreshes += 1;
    if (this.refreshFails !== null) return Promise.reject(this.refreshFails);
    return super.refresh(token);
  }

  override freeBusy(input: FreeBusyInput) {
    this.reads.push(input.accessToken);
    const failure = this.readFails.shift();
    if (failure !== undefined) return Promise.reject(failure);
    return this.busy === undefined ? super.freeBusy(input) : Promise.resolve(this.busy);
  }
}

async function connectedCalendar() {
  slugs += 1;
  const ownerId = await insertUser(db, 'owner');
  const tenant = await createBusiness(db, ownerId, {
    name: 'Fade Room',
    slug: `gsync-${String(slugs)}`,
    timeZone: 'America/New_York',
  });
  const tenantId = TenantIdSchema.parse(tenant.id);
  const clock = new ManualClock(START);
  const provider = new Scripted(REDIRECT, () => clock.now().getTime());
  const deps: CalendarDeps = {
    db,
    provider,
    tokenKey: calendarTokenKeyFrom(outboxKeyFrom('y'.repeat(40))),
    clock,
  };
  const userId = await insertUser(db, 'Jo');
  const staffMemberId = await withTenant(db, tenantId, async (tx) => {
    const membership = await addMembership(tx, { userId, role: 'staff' });
    const staff = await insertStaffMember(tx, {
      displayName: 'Jo',
      color: '#2a7230',
      active: true,
      membershipId: membership.id,
    });
    return StaffMemberIdSchema.parse(staff.id);
  });
  const jo: Actor = { context: { tenantId, userId, role: 'staff' } };
  const { url } = await startCalendarConnect(deps, jo);
  const state = new URL(url).searchParams.get('state') ?? '';
  await completeCalendarConnect(deps, jo, { code: 'sandbox-ok', state });
  const connectionId = await withTenant(db, tenantId, async (tx) => {
    const rows = await tx.execute('SELECT id FROM calendar_connections');
    return String((rows.rows[0] as { id: unknown }).id);
  });
  // The connect's own first read is done; count from here.
  provider.refreshes = 0;
  provider.reads = [];
  return { tenantId, clock, provider, deps, jo, staffMemberId, connectionId };
}

type Calendar = Awaited<ReturnType<typeof connectedCalendar>>;

/**
 * One pass for this calendar only. The worker's scan is across businesses, and this file's
 * earlier calendars stay due, so counts are taken per calendar.
 */
const pass = (c: Calendar) => readCalendar(c.deps, c.tenantId, c.connectionId);

async function busyToday(c: Calendar): Promise<string[]> {
  const rows = await withTenant(db, c.tenantId, (tx) =>
    listBusyBlocksBetween(tx, [c.staffMemberId], DAY),
  );
  return rows.map((b) => `${b.startsAt.toISOString()}–${b.endsAt.toISOString()}`);
}

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

describe('the read (AC-X-154)', () => {
  it('replaces the busy times every five minutes, start and end only, merged', async () => {
    const c = await connectedCalendar();
    expect(await busyToday(c)).toEqual(['2026-12-01T17:00:00.000Z–2026-12-01T18:00:00.000Z']);
    c.provider.busy = [
      { start: '2026-12-01T09:00:00-05:00', end: '2026-12-01T10:00:00-05:00' },
      { start: '2026-12-01T14:30:00Z', end: '2026-12-01T15:30:00Z' },
    ];
    // Not due yet: nothing is read.
    c.clock.advanceBy(4 * MINUTE);
    expect(await pass(c)).toBe('skipped');
    c.clock.advanceBy(MINUTE);
    // The worker's pass reads every due calendar, this one among them.
    expect((await runDueCalendarReads(c.deps)).read).toBeGreaterThanOrEqual(1);
    expect(await busyToday(c)).toEqual(['2026-12-01T14:00:00.000Z–2026-12-01T15:30:00.000Z']);
    expect((await readOwnCalendar(c.deps, c.jo)).connection?.syncedAt).toBe(
      c.clock.now().toISOString(),
    );
  });

  it('two workers at once read a calendar once', async () => {
    const c = await connectedCalendar();
    c.clock.advanceBy(5 * MINUTE);
    const outcomes = await Promise.all([
      readCalendar(c.deps, c.tenantId, c.connectionId),
      readCalendar(c.deps, c.tenantId, c.connectionId),
    ]);
    expect(outcomes.sort()).toEqual(['read', 'skipped']);
    expect(c.provider.reads).toHaveLength(1);
  });

  it.each([
    ['rate limited', new CalendarProviderError('rate_limited', 429)],
    ['Google unavailable', new CalendarProviderError('unavailable', 503)],
    ['a bad answer', new CalendarProviderError('bad_response')],
  ])('%s: keeps the last busy times and tries again next time', async (_, failure) => {
    const c = await connectedCalendar();
    c.provider.readFails = [failure];
    c.clock.advanceBy(5 * MINUTE);
    expect(await pass(c)).toBe('failed');
    expect(await busyToday(c)).toHaveLength(1);
    expect((await readOwnCalendar(c.deps, c.jo)).connection?.status).toBe('connected');
    c.clock.advanceBy(5 * MINUTE);
    expect(await pass(c)).toBe('read');
  });
});

describe('a token that can no longer be opened (the outbox secret changed)', () => {
  it('needs reconnecting, keeps its busy times, and is no longer read', async () => {
    const c = await connectedCalendar();
    const otherKey = { ...c.deps, tokenKey: calendarTokenKeyFrom(randomBytes(32)) };
    c.clock.advanceBy(5 * MINUTE);
    expect(await readCalendar(otherKey, c.tenantId, c.connectionId)).toBe('needs_reconnect');
    expect(await busyToday(c)).toHaveLength(1);
    c.clock.advanceBy(5 * MINUTE);
    expect(await pass(c)).toBe('skipped');
  });
});

describe('token expiry (AC-X-155)', () => {
  it('uses the stored access token while it lasts, then refreshes it first', async () => {
    const c = await connectedCalendar();
    c.clock.advanceBy(5 * MINUTE);
    await pass(c);
    expect(c.provider.refreshes).toBe(0);
    // The sandbox's access tokens last an hour; within a minute of that it is refreshed.
    c.clock.advanceBy(55 * MINUTE);
    await pass(c);
    expect(c.provider.refreshes).toBe(1);
    c.clock.advanceBy(5 * MINUTE);
    await pass(c);
    expect(c.provider.refreshes).toBe(1);
    expect(new Set(c.provider.reads).size).toBe(2);
  });

  it('refreshes once and asks again when Google says the access token is no good (401)', async () => {
    const c = await connectedCalendar();
    c.provider.readFails = [new CalendarProviderError('unauthorized', 401)];
    c.clock.advanceBy(5 * MINUTE);
    expect(await pass(c)).toBe('read');
    expect(c.provider.refreshes).toBe(1);
    expect(c.provider.reads).toHaveLength(2);
  });

  it('a second 401 after a refresh is a failure, not a loop', async () => {
    const c = await connectedCalendar();
    c.provider.readFails = [
      new CalendarProviderError('unauthorized', 401),
      new CalendarProviderError('unauthorized', 401),
    ];
    c.clock.advanceBy(5 * MINUTE);
    expect(await pass(c)).toBe('failed');
    expect(c.provider.refreshes).toBe(1);
  });

  it('a refused refresh token: needs reconnecting, keeps its busy times, audited once, no longer read', async () => {
    const c = await connectedCalendar();
    // Testing mode's 7 days pass: the access token has expired and Google refuses the refresh.
    c.clock.advanceBy(7 * 24 * 60 * MINUTE);
    c.provider.refreshFails = new CalendarProviderError('invalid_grant', 400);
    expect(await pass(c)).toBe('needs_reconnect');
    expect((await readOwnCalendar(c.deps, c.jo)).connection?.status).toBe('needs_reconnect');
    // The busy times stay, so nothing is double-booked while Jo reconnects.
    const kept = await withTenant(db, c.tenantId, (tx) =>
      listBusyBlocksBetween(tx, [c.staffMemberId], DAY),
    );
    expect(kept).toHaveLength(1);

    c.clock.advanceBy(10 * MINUTE);
    expect(await pass(c)).toBe('skipped');
    const audit = await withTenant(db, c.tenantId, (tx) => listAuditEntries(tx, { limit: 20 }));
    expect(
      audit
        .filter((a) => a.action === 'calendar.connection_changed')
        .map((a) => [a.actor.kind, a.after]),
    ).toEqual([['system', { status: 'needs_reconnect' }]]);

    // Reconnecting reads again at once.
    c.provider.refreshFails = null;
    const { url } = await startCalendarConnect(c.deps, c.jo);
    const state = new URL(url).searchParams.get('state') ?? '';
    const answer = await completeCalendarConnect(c.deps, c.jo, { code: 'sandbox-ok', state });
    expect(answer.connection?.status).toBe('connected');
    expect(answer.connection?.syncedAt).toBe(c.clock.now().toISOString());
    expect(c.provider.reads.length).toBeGreaterThan(0);
  });
});
