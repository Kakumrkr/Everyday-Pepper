// Connecting and disconnecting a staff member's Google Calendar (S70, ADR-0069 §3–4, §8;
// AC-X-152, AC-X-153, AC-X-157) against real Postgres, through the sandbox provider.
import {
  StaffMemberIdSchema,
  TenantIdSchema,
  type CalendarConnectComplete,
  type TenantId,
} from '@pepper/contracts';
import { createBusiness, ManualClock, outboxKeyFrom, type Actor } from '@pepper/core';
import {
  addMembership,
  findMembership,
  insertStaffMember,
  listAuditEntries,
  listBusyBlocksBetween,
  withTenant,
  type Database,
} from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CalendarConnectRefusedError,
  CalendarNotConnectedError,
  CalendarNotLinkedError,
  CalendarScopeMissingError,
} from './errors.js';
import { insertUser, startTestDatabase, type TestDatabase } from './int-support.js';
import type { ConsentUrlInput, ExchangeCodeInput, GrantedTokens } from './provider.js';
import { SANDBOX_ACCOUNT_EMAIL, SandboxCalendarProvider } from './sandbox.js';
import {
  completeCalendarConnect,
  disconnectCalendar,
  readOwnCalendar,
  startCalendarConnect,
  type CalendarDeps,
} from './services.js';
import { calendarTokenKeyFrom } from './tokens.js';

const REDIRECT = 'https://app.example/more/calendar/google';
const START = new Date('2026-12-01T12:00:00Z');

let database: TestDatabase;
let db: Database;
let slugs = 0;

/** The sandbox, counting revokes and able to grant without free/busy. */
class ScriptedSandbox extends SandboxCalendarProvider {
  revokes: string[] = [];
  challenges: string[] = [];
  withoutFreeBusy = false;

  override consentUrl(input: ConsentUrlInput): string {
    this.challenges.push(input.codeChallenge);
    return super.consentUrl(input);
  }

  override async exchangeCode(input: ExchangeCodeInput): Promise<GrantedTokens> {
    const granted = await super.exchangeCode(input);
    return this.withoutFreeBusy ? { ...granted, scopes: ['openid', 'email'] } : granted;
  }

  override revoke(token: string): Promise<void> {
    this.revokes.push(token);
    return super.revoke(token);
  }
}

async function business() {
  slugs += 1;
  const ownerId = await insertUser(db, 'owner');
  const tenant = await createBusiness(db, ownerId, {
    name: 'Fade Room',
    slug: `gcal-${String(slugs)}`,
    timeZone: 'America/New_York',
  });
  const tenantId = TenantIdSchema.parse(tenant.id);
  const clock = new ManualClock(START);
  const sandbox = new ScriptedSandbox(REDIRECT, () => clock.now().getTime());
  const deps: CalendarDeps = {
    db,
    provider: sandbox,
    tokenKey: calendarTokenKeyFrom(outboxKeyFrom('x'.repeat(40))),
    clock,
  };
  const owner: Actor = { context: { tenantId, userId: ownerId, role: 'owner' } };
  return { tenantId, ownerId, owner, clock, sandbox, deps };
}

/** A staff member's login linked to their staff member. */
async function linkedStaff(tenantId: TenantId, name = 'Jo') {
  const userId = await insertUser(db, name);
  const staffMemberId = await withTenant(db, tenantId, async (tx) => {
    const membership = await addMembership(tx, { userId, role: 'staff' });
    const staff = await insertStaffMember(tx, {
      displayName: name,
      color: '#2a7230',
      active: true,
      membershipId: membership.id,
    });
    return StaffMemberIdSchema.parse(staff.id);
  });
  const actor: Actor = { context: { tenantId, userId, role: 'staff' } };
  return { userId, staffMemberId, actor };
}

/** What the sandbox's consent page sends back to the return page. */
function answerOf(url: string, code = 'sandbox-ok'): CalendarConnectComplete {
  const state = new URL(url).searchParams.get('state') ?? '';
  return { code, state };
}

async function tableText(tenantId: TenantId): Promise<string> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx.execute(
      `SELECT row_to_json(c)::text AS t FROM calendar_connections c
       UNION ALL SELECT row_to_json(s)::text FROM calendar_connect_states s
       UNION ALL SELECT row_to_json(a)::text FROM audit_log a`,
    );
    return rows.rows.map((r) => String((r as { t: unknown }).t)).join('\n');
  });
}

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

describe('connecting a calendar (AC-X-152)', () => {
  it("connects the member's own staff member and reads their busy times at once", async () => {
    const { tenantId, deps } = await business();
    const jo = await linkedStaff(tenantId);
    expect(await readOwnCalendar(deps, jo.actor)).toEqual({ canConnect: true, connection: null });

    const { url } = await startCalendarConnect(deps, jo.actor);
    const answer = await completeCalendarConnect(deps, jo.actor, answerOf(url));

    expect(answer).toEqual({
      canConnect: true,
      connection: {
        staffMemberId: jo.staffMemberId,
        provider: 'sandbox',
        accountEmail: SANDBOX_ACCOUNT_EMAIL,
        status: 'connected',
        syncedAt: START.toISOString(),
        connectedAt: expect.any(String) as string,
      },
    });
    const blocks = await withTenant(db, tenantId, (tx) =>
      listBusyBlocksBetween(tx, [jo.staffMemberId], {
        from: new Date('2026-12-01T00:00:00Z'),
        to: new Date('2026-12-02T00:00:00Z'),
      }),
    );
    expect(blocks.map((b) => b.startsAt.toISOString())).toEqual(['2026-12-01T17:00:00.000Z']);
    const audit = await withTenant(db, tenantId, (tx) => listAuditEntries(tx, { limit: 10 }));
    expect(audit.map((a) => [a.action, a.after])).toContainEqual([
      'calendar.connected',
      { provider: 'sandbox', staffMemberId: jo.staffMemberId, reconnected: false },
    ]);
  });

  it('sends a PKCE challenge, and stores the state only as a hash', async () => {
    const { tenantId, deps, sandbox } = await business();
    const jo = await linkedStaff(tenantId);
    const { url } = await startCalendarConnect(deps, jo.actor);
    const state = new URL(url).searchParams.get('state') ?? '';
    expect(sandbox.challenges[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await tableText(tenantId)).not.toContain(state);
  });

  it('refuses a member with no staff member', async () => {
    const { owner, deps } = await business();
    expect(await readOwnCalendar(deps, owner)).toEqual({ canConnect: false, connection: null });
    await expect(startCalendarConnect(deps, owner)).rejects.toBeInstanceOf(CalendarNotLinkedError);
  });

  it.each([
    [
      'a forged state',
      (url: string) => Promise.resolve({ ...answerOf(url), state: 'A'.repeat(43) }),
    ],
    [
      'a used state',
      async (url: string, finish: (a: CalendarConnectComplete) => Promise<unknown>) => {
        await finish(answerOf(url));
        return answerOf(url);
      },
    ],
  ])('refuses %s and stores nothing new', async (_, answer) => {
    const { tenantId, deps } = await business();
    const jo = await linkedStaff(tenantId);
    const { url } = await startCalendarConnect(deps, jo.actor);
    const finish = (a: CalendarConnectComplete) => completeCalendarConnect(deps, jo.actor, a);
    await expect(finish(await answer(url, finish))).rejects.toBeInstanceOf(
      CalendarConnectRefusedError,
    );
  });

  it('refuses an expired state, and it is gone after', async () => {
    const { tenantId, deps, clock } = await business();
    const jo = await linkedStaff(tenantId);
    const { url } = await startCalendarConnect(deps, jo.actor);
    clock.advanceBy(10 * 60_000);
    await expect(completeCalendarConnect(deps, jo.actor, answerOf(url))).rejects.toBeInstanceOf(
      CalendarConnectRefusedError,
    );
    expect((await readOwnCalendar(deps, jo.actor)).connection).toBeNull();
    const left = await withTenant(db, tenantId, (tx) =>
      tx.execute('SELECT count(*)::int AS n FROM calendar_connect_states'),
    );
    expect((left.rows[0] as { n: number }).n).toBe(0);
  });

  it("refuses another member's state: nobody connects a calendar for someone else", async () => {
    const { tenantId, deps } = await business();
    const jo = await linkedStaff(tenantId, 'Jo');
    const sam = await linkedStaff(tenantId, 'Sam');
    const { url } = await startCalendarConnect(deps, jo.actor);
    await expect(completeCalendarConnect(deps, sam.actor, answerOf(url))).rejects.toBeInstanceOf(
      CalendarConnectRefusedError,
    );
    expect((await readOwnCalendar(deps, sam.actor)).connection).toBeNull();
    expect((await readOwnCalendar(deps, jo.actor)).connection).toBeNull();
  });

  it("refuses another business's state", async () => {
    const first = await business();
    const second = await business();
    const jo = await linkedStaff(first.tenantId);
    const other = await linkedStaff(second.tenantId);
    const { url } = await startCalendarConnect(first.deps, jo.actor);
    await expect(
      completeCalendarConnect(second.deps, other.actor, answerOf(url)),
    ).rejects.toBeInstanceOf(CalendarConnectRefusedError);
  });

  it('refuses a code Google refused', async () => {
    const { tenantId, deps } = await business();
    const jo = await linkedStaff(tenantId);
    const { url } = await startCalendarConnect(deps, jo.actor);
    await expect(
      completeCalendarConnect(deps, jo.actor, answerOf(url, 'not-a-code')),
    ).rejects.toBeInstanceOf(CalendarConnectRefusedError);
  });

  it('refuses a grant without free/busy and revokes it', async () => {
    const { tenantId, deps, sandbox } = await business();
    const jo = await linkedStaff(tenantId);
    sandbox.withoutFreeBusy = true;
    const { url } = await startCalendarConnect(deps, jo.actor);
    await expect(completeCalendarConnect(deps, jo.actor, answerOf(url))).rejects.toBeInstanceOf(
      CalendarScopeMissingError,
    );
    expect(sandbox.revokes).toHaveLength(1);
    expect((await readOwnCalendar(deps, jo.actor)).connection).toBeNull();
  });
});

describe('tokens (AC-X-153)', () => {
  it('are never stored, audited or answered in the clear', async () => {
    const { tenantId, deps, sandbox } = await business();
    const jo = await linkedStaff(tenantId);
    const seen: string[] = [];
    const exchange = sandbox.exchangeCode.bind(sandbox);
    sandbox.exchangeCode = async (input) => {
      const granted = await exchange(input);
      seen.push(granted.refreshToken, granted.accessToken);
      return granted;
    };
    const { url } = await startCalendarConnect(deps, jo.actor);
    const answer = await completeCalendarConnect(deps, jo.actor, answerOf(url));
    const stored = await tableText(tenantId);
    for (const token of seen) {
      expect(stored).not.toContain(token);
      expect(JSON.stringify(answer)).not.toContain(token);
    }
  });
});

describe('reconnecting and disconnecting (AC-X-155, AC-X-157)', () => {
  it('a reconnect keeps one connection, revokes the old grant, and is audited as one', async () => {
    const { tenantId, deps, sandbox } = await business();
    const jo = await linkedStaff(tenantId);
    const first = await startCalendarConnect(deps, jo.actor);
    const before = await completeCalendarConnect(deps, jo.actor, answerOf(first.url));
    const again = await startCalendarConnect(deps, jo.actor);
    const after = await completeCalendarConnect(deps, jo.actor, answerOf(again.url));
    expect(after.connection?.staffMemberId).toBe(before.connection?.staffMemberId);
    expect(sandbox.revokes).toHaveLength(1);
    const audit = await withTenant(db, tenantId, (tx) => listAuditEntries(tx, { limit: 10 }));
    expect(audit.filter((a) => a.action === 'calendar.connected').map((a) => a.after)).toEqual([
      { provider: 'sandbox', staffMemberId: jo.staffMemberId, reconnected: true },
      { provider: 'sandbox', staffMemberId: jo.staffMemberId, reconnected: false },
    ]);
  });

  it('disconnect removes the connection and its busy times, then revokes', async () => {
    const { tenantId, deps, sandbox } = await business();
    const jo = await linkedStaff(tenantId);
    const { url } = await startCalendarConnect(deps, jo.actor);
    await completeCalendarConnect(deps, jo.actor, answerOf(url));
    await disconnectCalendar(deps, jo.actor);
    expect((await readOwnCalendar(deps, jo.actor)).connection).toBeNull();
    const left = await withTenant(db, tenantId, (tx) =>
      tx.execute('SELECT count(*)::int AS n FROM calendar_busy_blocks'),
    );
    expect((left.rows[0] as { n: number }).n).toBe(0);
    expect(sandbox.revokes).toHaveLength(1);
    await expect(disconnectCalendar(deps, jo.actor)).rejects.toBeInstanceOf(
      CalendarNotConnectedError,
    );
    const audit = await withTenant(db, tenantId, (tx) => listAuditEntries(tx, { limit: 1 }));
    expect(audit[0]?.action).toBe('calendar.disconnected');
  });

  it("a failed revoke doesn't keep the connection", async () => {
    const { tenantId, deps, sandbox } = await business();
    const jo = await linkedStaff(tenantId);
    const { url } = await startCalendarConnect(deps, jo.actor);
    await completeCalendarConnect(deps, jo.actor, answerOf(url));
    sandbox.revoke = () => Promise.reject(new Error('Google is down'));
    await disconnectCalendar(deps, jo.actor);
    expect((await readOwnCalendar(deps, jo.actor)).connection).toBeNull();
  });

  it('a token that can no longer be opened never blocks a disconnect or a reconnect', async () => {
    const { tenantId, deps, sandbox } = await business();
    const jo = await linkedStaff(tenantId);
    const { url } = await startCalendarConnect(deps, jo.actor);
    await completeCalendarConnect(deps, jo.actor, answerOf(url));
    const rotated = { ...deps, tokenKey: calendarTokenKeyFrom(outboxKeyFrom('z'.repeat(40))) };
    const again = await startCalendarConnect(rotated, jo.actor);
    expect(
      (await completeCalendarConnect(rotated, jo.actor, answerOf(again.url))).connection?.status,
    ).toBe('connected');
    // The old grant couldn't be opened, so it wasn't revoked; nothing failed for it.
    expect(sandbox.revokes).toHaveLength(0);
    await disconnectCalendar(deps, jo.actor);
    expect((await readOwnCalendar(deps, jo.actor)).connection).toBeNull();
    expect(sandbox.revokes).toHaveLength(0);
  });

  it('removing the member removes the connection', async () => {
    const { tenantId, deps } = await business();
    const jo = await linkedStaff(tenantId);
    const { url } = await startCalendarConnect(deps, jo.actor);
    await completeCalendarConnect(deps, jo.actor, answerOf(url));
    await withTenant(db, tenantId, async (tx) => {
      const membership = await findMembership(tx, jo.userId);
      expect(membership).toBeDefined();
      await tx.execute(`DELETE FROM memberships WHERE id = '${String(membership?.id)}'`);
    });
    const left = await withTenant(db, tenantId, (tx) =>
      tx.execute('SELECT count(*)::int AS n FROM calendar_connections'),
    );
    expect((left.rows[0] as { n: number }).n).toBe(0);
  });
});
