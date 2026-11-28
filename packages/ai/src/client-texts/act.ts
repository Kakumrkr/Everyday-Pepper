import {
  confirmClientVisitIn,
  findAvailabilityIn,
  routeClientText,
  runningLatePush,
  type ClientTextRoute,
  type RoutableVisit,
  type TemplateRuleDefaultsOf,
} from '@pepper/appointments';
import {
  BookingIdSchema,
  CLIENT_TEXT_READ_LIMITS,
  OutboxDedupeKeySchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  UserIdSchema,
  UtcDateTimeSchema,
  formatDate,
  fromZoned,
  toZoned,
  type ClientTextCardOutcome,
  type OutboxClientText,
  type TenantId,
} from '@pepper/contracts';
import { proposeForBusiness, queuePushToMembers, type Actor, type Clock } from '@pepper/core';
import {
  findClientText,
  findClientUpcomingVisits,
  findCurrentTenant,
  findService,
  findStaffMember,
  listMemberships,
  listPushSubscriptionsOf,
  setClientTextCardOutcome,
  withTenant,
  type Database,
  type TenantTx,
} from '@pepper/db';
import { cancelBooking, moveBooking } from '../tools/catalog/bookings.js';
import { writeRunner } from '../tools/runner.js';
import type { ToolDeps } from '../tools/tool.js';
import { readClientText, type ClientTextReaderDeps } from './reader.js';

// A kept client text, read and acted on (S81a.2, ADR-0073; AC-X-242…247): the worker's
// `client_text` job. The text, its client and the client's visits come from the database, by the
// job's text id; the model only reads the words, and `routeClientText` decides. A sure confirm
// confirms the visit; running late tells the visit's staff member by push; a cancel or a move
// waits for an owner's or manager's OK; everything else is the owner's card, which shows every
// text and says what was done. The model is called outside any transaction.

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** A client running late may text a little after the visit started. */
const LATE_LOOKBACK_MS = 60 * MINUTE_MS;
/** How far ahead free times are offered for a move. */
const FREE_TIMES_DAYS = 7;
const FREE_TIMES = 3;

export interface ClientTextActorDeps extends ClientTextReaderDeps {
  db: Database;
  clock: Clock;
  /** For the client email an approved cancel or move queues, and the staff push. */
  emails: ToolDeps['emails'];
  templateRuleDefaults?: TemplateRuleDefaultsOf;
  /** Told when a cancel or a move can't be proposed (its name only), so the worker can log it. */
  onUnexpected?: (error: unknown) => void;
}

/** What the job did, for tests and the worker's log (no words, no names). */
export type ClientTextActResult =
  | { kind: 'gone' }
  | { kind: 'routed'; route: ClientTextRoute['kind']; read: 'read' | 'refused' | 'no_budget' };

/**
 * Reads the text the job names and acts on a sure reading. Idempotent: a second run finds the
 * visit already confirmed, the push already queued (by text) and the proposal already stored
 * (by text). It throws to be retried (the model or the database unavailable).
 */
export async function actOnClientText(
  deps: ClientTextActorDeps,
  tenantId: TenantId,
  job: OutboxClientText,
): Promise<ClientTextActResult> {
  const { db } = deps;
  const kept = await withTenant(db, tenantId, async (tx) => {
    const text = await findClientText(tx, job.textId);
    if (text?.direction !== 'in') return undefined;
    const tenant = await findCurrentTenant(tx);
    if (tenant === undefined) return undefined;
    const visits = await findClientUpcomingVisits(
      tx,
      text.clientId,
      new Date(text.createdAt.getTime() - LATE_LOOKBACK_MS),
      CLIENT_TEXT_READ_LIMITS.visits,
    );
    return { text, timeZone: tenant.timeZone, visits };
  });
  if (kept === undefined) return { kind: 'gone' };
  const { text, timeZone, visits } = kept;
  const receivedAt = text.createdAt;

  const outcome = await readClientText(deps, tenantId, {
    text: text.body,
    now: UtcDateTimeSchema.parse(receivedAt.toISOString()),
    timeZone,
    visits: visits.map((visit) => ({
      id: BookingIdSchema.parse(visit.bookingId),
      startsAt: UtcDateTimeSchema.parse(visit.startsAt.toISOString()),
    })),
  });
  const route = routeClientText({
    reading: outcome.kind === 'read' ? outcome.reading : null,
    visits,
    now: receivedAt,
    timeZone,
  });

  await withTenant(db, tenantId, async (tx) => {
    const shown = await act(
      tx,
      deps,
      { tenantId, textId: text.id, clientId: text.clientId },
      route,
      {
        timeZone,
        receivedAt,
      },
    );
    if (shown === null) return;
    await setClientTextCardOutcome(tx, {
      textId: text.id,
      outcome: shown,
      ...(route.kind !== 'card' && { visit: route.visit }),
    });
  });
  return { kind: 'routed', route: route.kind, read: outcome.kind };
}

/** Does what the route says; what the card then says (`null`: nothing to add). */
async function act(
  tx: TenantTx,
  deps: ClientTextActorDeps,
  text: { tenantId: TenantId; textId: string; clientId: string },
  route: ClientTextRoute,
  at: { timeZone: string; receivedAt: Date },
): Promise<ClientTextCardOutcome | null> {
  switch (route.kind) {
    case 'card':
      return route.reason === 'which_visit' ? { kind: 'which_visit' } : null;
    case 'confirm': {
      const { outcome } = await confirmClientVisitIn(tx, {
        bookingId: BookingIdSchema.parse(route.visit.bookingId),
        clientId: text.clientId,
        at: at.receivedAt,
      });
      return outcome === 'nothing' ? null : { kind: 'confirmed' };
    }
    case 'late':
      return (await tellStaff(tx, deps, text.textId, route.visit, route.minutesLate, at))
        ? { kind: 'told_staff', minutesLate: route.minutesLate }
        : null;
    case 'cancel':
      return (await propose(tx, deps, text, 'cancel', { bookingId: route.visit.bookingId }))
        ? { kind: 'cancel_waiting' }
        : null;
    case 'move':
      return move(tx, deps, text, route.visit, route.askedFor, at);
  }
}

/** The visit's staff member's devices, when linked to a login (AC-X-244); whether any is told. */
async function tellStaff(
  tx: TenantTx,
  deps: ClientTextActorDeps,
  textId: string,
  visit: RoutableVisit,
  minutesLate: number | null,
  at: { timeZone: string; receivedAt: Date },
): Promise<boolean> {
  const staff = await findStaffMember(tx, StaffMemberIdSchema.parse(visit.staffMemberId));
  const service = await findService(tx, ServiceIdSchema.parse(visit.serviceId));
  const staffUser = staff?.userId ?? null;
  if (staffUser === null || service === undefined) return false;
  const userId = UserIdSchema.parse(staffUser);
  // No device: nobody to tell, so the card alone says it.
  if ((await listPushSubscriptionsOf(tx, [userId])).length === 0) return false;
  // One push per text and device: a retry queues none again.
  await queuePushToMembers(
    tx,
    [userId],
    runningLatePush({
      serviceName: service.name,
      startsAt: visit.startsAt.toISOString(),
      timeZone: at.timeZone,
      minutesLate,
      bookingId: visit.bookingId,
    }),
    {
      key: deps.emails.outboxKey,
      dedupeKey: OutboxDedupeKeySchema.parse(`push.client_late:${textId}`),
      now: deps.clock.now(),
    },
  );
  return true;
}

/**
 * A move: to the time the client asked for when it is free with the same staff member, waiting
 * for an OK (AC-X-245); else the next free times from the day asked for (or the visit's), for the
 * owner to offer. Pepper never picks a time nobody asked for.
 */
async function move(
  tx: TenantTx,
  deps: ClientTextActorDeps,
  text: { tenantId: TenantId; textId: string; clientId: string },
  visit: RoutableVisit,
  askedFor: { date: string | null; time: string | null } | null,
  at: { timeZone: string; receivedAt: Date },
): Promise<ClientTextCardOutcome | null> {
  const ai = await aiOf(tx, text.tenantId, text.textId);
  if (ai === undefined) return null;
  const now = deps.clock.now().getTime();
  const date = askedFor?.date ?? formatDate(toZoned(at.timeZone, visit.startsAt.getTime()));
  const free = (from: number, to: number, limit: number) =>
    findAvailabilityIn(
      tx,
      ai,
      {
        serviceId: ServiceIdSchema.parse(visit.serviceId),
        staffMemberId: StaffMemberIdSchema.parse(visit.staffMemberId),
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
      },
      {
        clock: deps.clock,
        limit,
        excludeBookingId: visit.bookingId,
        ...(deps.templateRuleDefaults !== undefined && {
          templateRuleDefaults: deps.templateRuleDefaults,
        }),
      },
    );
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const civil = { year, month, day };
  const time = askedFor?.time ?? null;
  if (time !== null) {
    const [hours, minutes] = time.split(':').map(Number) as [number, number];
    const asked = fromZoned(at.timeZone, civil, hours * 60 + minutes);
    if (asked > now && asked !== visit.startsAt.getTime()) {
      const [slot] = await free(asked, asked + MINUTE_MS, 1);
      if (slot !== undefined && Date.parse(slot.startsAt) === asked) {
        const proposed = await propose(tx, deps, text, 'move', {
          bookingId: visit.bookingId,
          date,
          time,
          staffMemberId: null,
        });
        return proposed ? { kind: 'move_waiting', to: slot.startsAt } : null;
      }
    }
  }
  const from = Math.max(now, fromZoned(at.timeZone, civil, 0));
  const times = (await free(from, from + FREE_TIMES_DAYS * DAY_MS, FREE_TIMES + 1))
    .map((slot) => slot.startsAt)
    // The visit's own time is no move.
    .filter((startsAt) => Date.parse(startsAt) !== visit.startsAt.getTime())
    .slice(0, FREE_TIMES);
  return times.length === 0 ? null : { kind: 'free_times', times };
}

/** The business's AI acting for its owner: its proposals wait for an owner or manager. */
async function aiOf(tx: TenantTx, tenantId: TenantId, textId: string): Promise<Actor | undefined> {
  const owner = (await listMemberships(tx)).find((member) => member.role === 'owner');
  if (owner === undefined) return undefined;
  return {
    context: { tenantId, userId: UserIdSchema.parse(owner.userId), role: 'owner' },
    requestId: `client-text-${textId}`,
    via: 'ai',
  };
}

/**
 * A cancel or a move of the client's visit waiting in "Needs your OK" (AC-X-245): never run
 * without a person, the client's words marked as outside text. One per text; whether it waits.
 */
async function propose(
  tx: TenantTx,
  deps: ClientTextActorDeps,
  text: { tenantId: TenantId; textId: string },
  kind: 'cancel' | 'move',
  payload: Record<string, string | null>,
): Promise<boolean> {
  const ai = await aiOf(tx, text.tenantId, text.textId);
  if (ai === undefined) return false;
  const toolDeps: ToolDeps = {
    db: deps.db,
    actor: ai,
    clock: deps.clock,
    ...(deps.templateRuleDefaults !== undefined && {
      templateRuleDefaults: deps.templateRuleDefaults,
    }),
    // A proposal never runs by itself, whatever the dial says (proposeForBusiness).
    autonomy: { templateDefaults: {} },
    emails: deps.emails,
  };
  const tool = kind === 'cancel' ? cancelBooking : moveBooking;
  const args = { ...payload, emailClient: null };
  try {
    await tx.transaction((savepoint) =>
      proposeForBusiness(
        savepoint,
        ai,
        writeRunner(tool, toolDeps, args).runner,
        {
          payload: args,
          idempotencyKey: `client_text.${kind}.${text.textId}`,
          explanation: {
            requestMessageId: null,
            steps: [{ tool: 'read_client_text', input: {} }],
            facts: [],
            alternatives: [],
          },
          // The ask came in the client's own words, from outside the team.
          untrustedContext: true,
        },
        { clock: deps.clock },
      ),
    );
    return true;
  } catch (error) {
    // The domain refusing it (the visit changed, the time just taken) leaves the card to ask.
    deps.onUnexpected?.(error);
    return false;
  }
}
