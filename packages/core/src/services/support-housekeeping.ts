import {
  SUPPORT_OVERDUE_HOURS,
  SUPPORT_QUIET_DAYS,
  TenantIdSchema,
  type SupportKind,
} from '@pepper/contracts';
import {
  appendAuditEntry,
  findCurrentTenant,
  closeQuietPublicSupportRequests,
  listDueSupportThreads,
  listOverduePublicSupportRequests,
  lockDueSupportThread,
  markPublicSupportRequestReminded,
  markSupportThreadReminded,
  setSupportThreadStatus,
  withTenant,
  type Database,
  type SupportThreadDue,
  type TenantTx,
} from '@pepper/db';
import { systemClock, type Clock } from '../clock.js';
import type { Mailer } from '../outbox.js';
import { queueEmail } from './outbox.js';
import { findSupportOpener, firstNameOf, SUPPORT_KIND_LABELS } from './support.js';
import { sweepUnsentSupportScreenshots, type ScreenshotStorage } from './support-screenshots.js';

// The support job (S59.2.2, ADR-0062, AC-X-24/25), run by the worker every few minutes. It
// keeps two promises without anyone watching the inbox: a request waiting on Pepper for 4 h
// reminds the team's address once a wait (the same-day promise of AC-X-14), and a request the
// team answered that has been quiet for 7 days is solved, its requester told once. A request
// waiting on Pepper is never closed. Two workers may run it side by side: each thread is checked
// again under its lock, bound to its business, and public requests change in one statement.

export interface SupportHousekeepingOptions {
  /** Seals queued emails (ADR-0024). */
  outboxKey: Buffer;
  /** The team's address (`SUPPORT_EMAIL`); `null`: no reminders are sent. */
  supportEmail: string | null;
  /** The web app's origin, for the console's and the thread's links; `null`: no links. */
  baseUrl: string | null;
  /** Sends the public requests' reminders, which have no business's outbox; `null`: none. */
  mailer: Mailer | null;
  clock?: Clock;
  /** Threads looked at in one pass (the rest wait for the next). */
  limit?: number;
  /** Where screenshots live: unsent ones over a day old are swept (S59.2.3, AC-X-28). */
  store?: ScreenshotStorage | null;
}

export interface SupportHousekeepingResult {
  /** Requests solved after 7 quiet days. */
  closed: number;
  /** Reminders sent (queued) to the team's address. */
  reminded: number;
  /** Unsent screenshots deleted after 24 h. */
  swept: number;
  /** Threads (or the public sweep) that failed; the next pass tries again. */
  failed: number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_LIMIT = 200;

/** One pass of the support job. */
export async function runSupportHousekeeping(
  db: Database,
  options: SupportHousekeepingOptions,
): Promise<SupportHousekeepingResult> {
  const now = (options.clock ?? systemClock).now();
  const overdueBefore = new Date(now.getTime() - SUPPORT_OVERDUE_HOURS * HOUR_MS);
  const quietBefore = new Date(now.getTime() - SUPPORT_QUIET_DAYS * DAY_MS);
  const result: SupportHousekeepingResult = { closed: 0, reminded: 0, swept: 0, failed: 0 };
  const due = await listDueSupportThreads(db, {
    // Without a team address nothing is reminded, or marked: those waits aren't even looked at.
    overdueBefore: options.supportEmail === null ? new Date(0) : overdueBefore,
    quietBefore,
    limit: options.limit ?? DEFAULT_LIMIT,
  });
  for (const { tenantId, threadId } of due) {
    try {
      const done = await withTenant(db, TenantIdSchema.parse(tenantId), async (tx) => {
        const thread = await lockDueSupportThread(tx, threadId);
        if (thread === undefined) return null;
        if (options.supportEmail !== null && isOverdue(thread, overdueBefore)) {
          await remindTeam(tx, thread, now, options.supportEmail, options);
          return 'reminded';
        }
        if (thread.status === 'pepper_replied' && thread.quietSince <= quietBefore) {
          await closeQuiet(tx, thread, now, options);
          return 'closed';
        }
        return null;
      });
      if (done !== null) result[done] += 1;
    } catch {
      // Counted only: never a business's or a request's id in the logs.
      result.failed += 1;
    }
  }
  try {
    await sweepPublic(db, now, options, result);
  } catch {
    result.failed += 1;
  }
  try {
    result.swept = await sweepUnsentSupportScreenshots(db, {
      store: options.store ?? null,
      clock: { now: () => now },
    });
  } catch {
    result.failed += 1;
  }
  return result;
}

/** Waiting on Pepper since `overdueBefore` or earlier, and not reminded of this wait yet. */
export function isOverdue(
  thread: Pick<SupportThreadDue, 'status' | 'waitingSince' | 'overdueRemindedAt'>,
  overdueBefore: Date,
): boolean {
  return (
    thread.status === 'waiting_on_pepper' &&
    thread.waitingSince <= overdueBefore &&
    (thread.overdueRemindedAt === null || thread.overdueRemindedAt < thread.waitingSince)
  );
}

/** "4 h", "26 h": how long it has waited, in whole hours. */
export function waitedHours(since: Date, now: Date): string {
  return `${String(Math.max(SUPPORT_OVERDUE_HOURS, Math.floor((now.getTime() - since.getTime()) / HOUR_MS)))} h`;
}

/** The reminder's subject and text (AC-X-25): no message text, only what to open. */
export function overdueEmail(input: {
  reference: string;
  kind: SupportKind | null;
  business: string | null;
  waited: string;
  link: string | null;
}): { subject: string; text: string } {
  const from = input.business ?? 'Signed-out';
  const what = input.kind === null ? 'Public form' : SUPPORT_KIND_LABELS[input.kind];
  return {
    subject: `[${input.reference}] Waiting ${input.waited}: answer it today — ${from}`,
    text: [
      `${input.reference} · ${what} · ${from}`,
      `It has waited ${input.waited} for an answer. We promise one the same day.`,
      '',
      input.link === null ? 'Open it in the console.' : `Open it in the console: ${input.link}`,
      '',
      'One reminder a wait; a new message from them starts a new wait.',
    ].join('\n'),
  };
}

/** Queues the team's reminder and records it, in the business's transaction. */
async function remindTeam(
  tx: TenantTx,
  thread: SupportThreadDue,
  now: Date,
  supportEmail: string,
  options: SupportHousekeepingOptions,
): Promise<void> {
  await markSupportThreadReminded(tx, thread.id, now);
  const tenant = await findCurrentTenant(tx);
  const mail = overdueEmail({
    reference: thread.reference,
    kind: thread.kind,
    business: tenant?.name ?? null,
    waited: waitedHours(thread.waitingSince, now),
    link: options.baseUrl === null ? null : `${options.baseUrl}/ops/threads/${thread.id}`,
  });
  await queueEmail(
    tx,
    { to: supportEmail, ...mail },
    {
      key: options.outboxKey,
      dedupeKey: `support.overdue:${thread.id}:${thread.waitingSince.toISOString()}`,
      now,
    },
  );
}

/** Solves a quiet request as the system and tells its requester once (AC-X-24). */
async function closeQuiet(
  tx: TenantTx,
  thread: SupportThreadDue,
  now: Date,
  options: SupportHousekeepingOptions,
): Promise<void> {
  await setSupportThreadStatus(tx, thread.id, 'solved', now, { solvedBy: 'auto' });
  await appendAuditEntry(tx, {
    actor: { kind: 'system' },
    change: {
      action: 'support_thread.solved',
      entity: { type: 'support_thread', id: thread.id },
      before: { status: thread.status },
      after: { status: 'solved' },
    },
  });
  const opener = await findSupportOpener(tx, thread.openedByUserId);
  if (opener === undefined) return;
  const firstName = firstNameOf(opener.name);
  const link = options.baseUrl === null ? null : `${options.baseUrl}/support/${thread.id}`;
  await queueEmail(
    tx,
    {
      to: opener.email,
      subject: `We closed ${thread.reference}`,
      text: [
        firstName === '' ? 'Hi,' : `Hi ${firstName},`,
        '',
        `We closed your request ${thread.reference} after ${String(SUPPORT_QUIET_DAYS)} quiet days.`,
        link === null
          ? 'If it isn’t sorted, reply in the app and it opens again.'
          : `If it isn’t sorted, reply in the app and it opens again: ${link}`,
        '',
        '— The Pepper team',
      ].join('\n'),
      ...(options.supportEmail !== null && { replyTo: options.supportEmail }),
    },
    {
      key: options.outboxKey,
      dedupeKey: `support.closed:${thread.id}:${thread.quietSince.toISOString()}`,
      now,
    },
  );
}

/**
 * Public requests (no business, no outbox): quiet answered ones close in one statement; each
 * reminder is its own short transaction, marked and sent together, so a refused email undoes
 * only its own mark and the next pass tries it again (nothing else is sent twice).
 */
async function sweepPublic(
  db: Database,
  now: Date,
  options: SupportHousekeepingOptions,
  result: SupportHousekeepingResult,
): Promise<void> {
  try {
    result.closed += await closeQuietPublicSupportRequests(db, now);
  } catch {
    result.failed += 1;
  }
  const { mailer, supportEmail } = options;
  // Nothing to send with: nothing is marked, so the reminders go once there is.
  if (mailer === null || supportEmail === null) return;
  const overdue = await listOverduePublicSupportRequests(db, now, options.limit ?? DEFAULT_LIMIT);
  for (const request of overdue) {
    try {
      const sent = await db.transaction(async (tx) => {
        if (!(await markPublicSupportRequestReminded(tx, request.id, now))) return false;
        const mail = overdueEmail({
          reference: request.reference,
          kind: null,
          business: null,
          waited: waitedHours(request.waitingSince, now),
          link: options.baseUrl === null ? null : `${options.baseUrl}/ops/requests/${request.id}`,
        });
        await mailer.send({ to: supportEmail, ...mail });
        return true;
      });
      if (sent) result.reminded += 1;
    } catch {
      result.failed += 1;
    }
  }
}
