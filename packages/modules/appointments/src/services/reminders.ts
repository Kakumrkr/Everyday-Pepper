import { createHash, randomBytes } from 'node:crypto';
import {
  BookingIdSchema,
  ClientIdSchema,
  CONFIRM_ASK_LEAD_HOURS,
  inHoldbackShare,
  ManageTokenSchema,
  OutboxDedupeKeySchema,
  reminderSettingsFrom,
  smsSendableAt,
  TenantIdSchema,
  fromZoned,
  toZoned,
  type BookingId,
  type TenantId,
  type ReminderKind,
  type ReminderSettings,
} from '@pepper/contracts';
import { queueEmail, queueSms, smsPermission, type Clock } from '@pepper/core';
import {
  deleteBookingManageLink,
  findCurrentTenant,
  hasReminderText,
  insertBookingManageLink,
  insertBookingText,
  listActiveSmsConsentsForClient,
  listBookings,
  listDueBookingReminders,
  listVisitRisks,
  lockBooking,
  markBookingConfirmAsked,
  markBookingConfirmHeldBack,
  planBookingReminder,
  removeBookingReminder,
  takeDueBookingReminder,
  withTenant,
  type BookingRow,
  type Database,
  type DueReminder,
  type Tenant,
  type TenantTx,
} from '@pepper/db';
import { confirmAskEmail, manageUrl, reminderEmail } from '../emails.js';
import { reminderText } from '../texts.js';
import { emailDetailsOf } from './notices.js';
import { keepReleaseCardInStep, releaseCheck } from './release-check.js';

// Booking reminders (W6, AC-W6-1, ADR-0025; S62 AC-X-70…72): every confirmed booking has its
// reminders planned in the booking's own transaction, so a cancelled booking never keeps one
// and a moved booking's reminders move with it. Two kinds: the day before (by text when the
// client said yes and the business may text them, else by email) and the same day (by text
// only), each at a time kept out of the night in the business's zone. A booking made under 24 h
// ahead still gets the same-day text; one made under its lead gets none (its confirmation has
// just been sent). The worker's reminder job sends what is due (`sendDueReminders`): it checks
// the booking again under its lock and queues the text or email in the outbox in the same
// transaction that takes the reminder, so each is queued at most once.
//
// The confirm ask (S78, AC-X-204): while the business asks clients to confirm, every visit
// booked more than `CONFIRM_ASK_LEAD_HOURS` ahead has one planned that far ahead; when it falls
// due it goes only if the visit is in the high risk band (S77) and the client hasn't confirmed,
// by text where one may go, else by email with the confirm link. Any reminder that asks to
// confirm records the ask on the booking, so visit risk scores `not_confirmed` only after it.
//
// The release check (S78.2, AC-X-207): while the business asks, every visit has one planned at
// its cut-off (`confirmCutoffHours` before, S78.3; not moved out of the night: it reaches no
// client).
// When due, a visit asked early enough and still unconfirmed gets the owner's release card
// (`onReleaseDue`, the worker's proposer); nothing goes to the client.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** How long before a booking's start its day-before reminder is due (before the hours). */
export const REMINDER_LEAD_MS = 24 * HOUR_MS;
/** A same-day text that would leave less than this before the start isn't sent. */
export const SAME_DAY_MIN_NOTICE_MS = 30 * MINUTE_MS;
/** The earliest a reminder is planned in the business's zone. */
const MORNING_MINUTE = 8 * 60;
/** From this minute on, a reminder is planned for `EVENING_MINUTE` instead. */
const NIGHT_MINUTE = 20 * 60;
const EVENING_MINUTE = 19 * 60 + 30;

/** The planned instant moved out of the night: before 8:00 to 8:00, from 20:00 to 19:30. */
function keptInHours(timeZone: string, instant: number): number {
  const local = toZoned(timeZone, instant);
  const date = { year: local.year, month: local.month, day: local.day };
  if (local.minuteOfDay < MORNING_MINUTE) return fromZoned(timeZone, date, MORNING_MINUTE);
  if (local.minuteOfDay >= NIGHT_MINUTE) return fromZoned(timeZone, date, EVENING_MINUTE);
  return instant;
}

function sameLocalDay(timeZone: string, a: number, b: number): boolean {
  const x = toZoned(timeZone, a);
  const y = toZoned(timeZone, b);
  return x.year === y.year && x.month === y.month && x.day === y.day;
}

/**
 * When a booking's reminder of `kind` is due (AC-X-70), or `null` when it has none: the day
 * before at 24 h ahead, the same day at the business's lead (on the start's own day, at least 30
 * minutes ahead), each kept out of the night; none when the business turned it off. The
 * same-day one is a text, so it needs texts on too.
 */
export function reminderDueAt(
  kind: ReminderKind,
  startsAt: number,
  timeZone: string,
  settings: ReminderSettings,
): number | null {
  if (kind === 'release_check') {
    return settings.askToConfirm ? startsAt - settings.confirmCutoffHours * HOUR_MS : null;
  }
  if (kind === 'confirm_ask') {
    return settings.askToConfirm
      ? keptInHours(timeZone, startsAt - CONFIRM_ASK_LEAD_HOURS * HOUR_MS)
      : null;
  }
  if (kind === 'day_before') {
    return settings.dayBefore ? keptInHours(timeZone, startsAt - REMINDER_LEAD_MS) : null;
  }
  if (!settings.sameDay || !settings.texts) return null;
  const due = keptInHours(timeZone, startsAt - settings.sameDayLeadHours * HOUR_MS);
  if (!sameLocalDay(timeZone, due, startsAt)) return null;
  return due <= startsAt - SAME_DAY_MIN_NOTICE_MS ? due : null;
}

const KINDS: readonly ReminderKind[] = ['confirm_ask', 'day_before', 'same_day', 'release_check'];

/** A business's reminder settings, each missing or unreadable field at its default. */
export function reminderSettingsOf(tenant: Pick<Tenant, 'reminderSettings'>): ReminderSettings {
  return reminderSettingsFrom(tenant.reminderSettings);
}

/**
 * Plans, moves or removes the reminders of a booking just written (`row` as it is now), as of
 * `now` (ms). Call it in the transaction that wrote the booking.
 */
export async function keepReminderInStep(
  tx: TenantTx,
  row: BookingRow,
  now: number,
): Promise<void> {
  const tenant = await findCurrentTenant(tx);
  if (tenant === undefined) throw new Error('A booking is written in its business’s transaction');
  await keepRemindersOf(tx, row, now, tenant.timeZone, reminderSettingsOf(tenant));
  // A release card that no longer fits the visit goes (S78.2, AC-X-210).
  await keepReleaseCardInStep(tx, row, now);
}

/**
 * `keepDue`: a re-plan for a settings change leaves a reminder that is due but not yet taken
 * (between the job's polls, or a backlog) for the job, which checks the settings again; a
 * booking change replaces it, as it just told the client.
 */
async function keepRemindersOf(
  tx: TenantTx,
  row: BookingRow,
  now: number,
  timeZone: string,
  settings: ReminderSettings,
  options: { keepDue?: boolean } = {},
): Promise<void> {
  const bookingId = BookingIdSchema.parse(row.id);
  for (const kind of KINDS) {
    const dueAt =
      row.status === 'confirmed'
        ? reminderDueAt(kind, row.startsAt.getTime(), timeZone, settings)
        : null;
    if (dueAt !== null && dueAt > now) {
      await planBookingReminder(tx, {
        bookingId,
        kind,
        dueAt: new Date(dueAt),
        startsAt: row.startsAt,
      });
    } else if (dueAt === null || options.keepDue !== true) {
      await removeBookingReminder(tx, bookingId, kind);
    }
  }
}

/** Upcoming bookings a settings change re-plans at a time. */
const REPLAN_PAGE = 500;
/** How far ahead a settings change re-plans: past any booking window a business can set. */
const REPLAN_HORIZON_MS = 3 * 366 * 24 * HOUR_MS;

/**
 * Re-plans every upcoming confirmed booking's reminders with `settings` (a settings change,
 * AC-X-75), in the change's transaction, a page at a time. Returns how many it re-planned.
 */
export async function replanUpcomingReminders(
  tx: TenantTx,
  timeZone: string,
  settings: ReminderSettings,
  now: number,
): Promise<number> {
  const to = new Date(now + REPLAN_HORIZON_MS);
  const seen = new Set<string>();
  let from = new Date(now);
  for (;;) {
    const page = await listBookings(tx, { from, to, status: 'confirmed', limit: REPLAN_PAGE });
    for (const row of page) {
      if (seen.has(row.id) || row.startsAt.getTime() <= now) continue;
      seen.add(row.id);
      await keepRemindersOf(tx, row, now, timeZone, settings, { keepDue: true });
    }
    const last = page.at(-1);
    // The next page starts at the last start (rows there already seen are skipped).
    if (
      page.length < REPLAN_PAGE ||
      last === undefined ||
      last.startsAt.getTime() <= from.getTime()
    ) {
      return seen.size;
    }
    from = last.startsAt;
  }
}

/** Reminders the job lists at a time. */
export const REMINDER_BATCH = 100;
/** Batches per pass at most, so one pass ends even if reminders keep falling due. */
export const REMINDER_BATCHES_PER_PASS = 20;

export interface ReminderOptions {
  /** Seals the queued email or text (the outbox key, ADR-0024). */
  key: Buffer;
  clock: Clock;
  /** The web app's origin, for the reminder's reschedule/cancel link; none without it. */
  baseUrl?: string | null;
  /** Whether this deployment sends texts (`SMS_PROVIDER` set, ADR-0065); default no. */
  texts?: boolean;
  /**
   * Proposes the release card for a visit due at its cut-off (S78.2; the worker's, from
   * `@pepper/ai`), in the reminder's transaction: whether a card now waits. Without it the
   * release check is skipped.
   */
  onReleaseDue?: (
    tx: TenantTx,
    booking: { tenantId: TenantId; bookingId: BookingId },
  ) => Promise<boolean>;
}

/** What handling one due reminder did. */
export type ReminderResult = 'queued' | 'skipped';

/**
 * Handles one due reminder under its business's tenant: locks the booking (so a concurrent
 * cancellation or move either commits first and is seen, or waits), takes the reminder, and
 * queues it when the booking is still confirmed at the planned start, has not started, and the
 * business still sends this kind (AC-X-71): by text to the number on the client's consent in
 * force when the business may text it, else (the day-before one) by email to an address on
 * file. `skipped`: none of that (the reminder is gone either way), or another worker took it.
 */
export async function sendDueReminder(
  db: Database,
  due: DueReminder,
  options: ReminderOptions,
): Promise<ReminderResult> {
  const bookingId = BookingIdSchema.parse(due.bookingId);
  const now = options.clock.now();
  return withTenant(db, TenantIdSchema.parse(due.tenantId), async (tx) => {
    // The booking first, then its reminder: the same order as every booking change.
    const booking = await lockBooking(tx, bookingId);
    const reminder = await takeDueBookingReminder(tx, bookingId, due.kind, now);
    if (booking === undefined || reminder === undefined) return 'skipped';
    const startsAt = booking.startsAt.getTime();
    if (
      booking.status !== 'confirmed' ||
      startsAt !== reminder.startsAt.getTime() ||
      startsAt <= now.getTime()
    ) {
      return 'skipped';
    }
    const tenant = await findCurrentTenant(tx);
    if (tenant === undefined) return 'skipped';
    const settings = reminderSettingsOf(tenant);
    // Turned off since it was planned.
    if (reminderDueAt(due.kind, startsAt, tenant.timeZone, settings) === null) return 'skipped';
    // The release check reaches the owner, never the client (AC-X-207).
    if (due.kind === 'release_check') {
      if (options.onReleaseDue === undefined) return 'skipped';
      if (releaseCheck(booking, settings, now.getTime()) !== 'ok') return 'skipped';
      const tenantId = TenantIdSchema.parse(due.tenantId);
      return (await options.onReleaseDue(tx, { tenantId, bookingId })) ? 'queued' : 'skipped';
    }
    // The confirm ask: only a high-band visit the client hasn't confirmed (AC-X-204), and not one
    // the holdback keeps back, which is marked instead (S78.3, AC-X-215).
    if (due.kind === 'confirm_ask') {
      const ask = await confirmAskOf(tx, booking, settings);
      if (ask === 'held_back') await markBookingConfirmHeldBack(tx, bookingId, now);
      if (ask !== 'ask') return 'skipped';
    }
    const details = await emailDetailsOf(tx, tenant, booking, now.getTime());
    const phone =
      options.texts === true && settings.texts ? await textableNumber(tx, booking.clientId) : null;
    if (phone === null && (due.kind === 'same_day' || details.email === '')) return 'skipped';
    const link = await reminderLink(tx, tenant, booking, now, options.baseUrl ?? null);
    // An emailed ask needs its link to be answered.
    if (phone === null && due.kind === 'confirm_ask' && link === null) return 'skipped';
    const askToConfirm = booking.clientConfirmedAt === null;
    if (phone !== null) {
      const clientId = ClientIdSchema.parse(booking.clientId);
      const sendable = smsSendableAt(tenant.timeZone, now.getTime());
      const id = await queueSms(
        tx,
        {
          to: phone,
          body: reminderText({
            kind: due.kind,
            details,
            link: link?.url ?? null,
            askToConfirm,
            first: !(await hasReminderText(tx, clientId)),
            today: sameLocalDay(tenant.timeZone, sendable, startsAt),
          }),
          wordsBy: 'template',
        },
        {
          key: options.key,
          // One text per booking, kind and start, even if a reminder were somehow planned twice.
          dedupeKey: OutboxDedupeKeySchema.parse(
            `booking.reminder.${due.kind}:${bookingId}:${String(startsAt)}`,
          ),
          now,
        },
      );
      if (id === undefined) return dropLink(tx, link);
      await insertBookingText(tx, {
        id,
        clientId,
        bookingId,
        kind: due.kind,
        startsAt: booking.startsAt,
        createdAt: now,
      });
      if (askToConfirm) await markBookingConfirmAsked(tx, bookingId, now);
      return 'queued';
    }
    const email =
      due.kind === 'confirm_ask' && link !== null
        ? confirmAskEmail(details, link.url)
        : reminderEmail(details, link?.url ?? null);
    const queued = await queueEmail(tx, email, {
      key: options.key,
      // One reminder per booking and start, even if a reminder were somehow planned twice.
      dedupeKey: OutboxDedupeKeySchema.parse(
        due.kind === 'confirm_ask'
          ? `booking.confirm_ask:${bookingId}:${String(startsAt)}`
          : `booking.reminder:${bookingId}:${String(startsAt)}`,
      ),
      now,
    });
    if (queued === undefined) return dropLink(tx, link);
    // The email asks only with its link, while the business asks (S78, AC-X-205).
    if (link !== null && details.askConfirm === true) {
      await markBookingConfirmAsked(tx, bookingId, now);
    }
    return 'queued';
  });
}

/**
 * Whether the confirm ask goes: `ask` when the client hasn't confirmed and the visit is
 * high-band (S77); `held_back` when such a visit falls in the held-back share while the
 * business has the holdback on (S78.3, AC-X-215), or was held back before a move; `skip`
 * otherwise.
 */
async function confirmAskOf(
  tx: TenantTx,
  booking: BookingRow,
  settings: Pick<ReminderSettings, 'holdback'>,
): Promise<'ask' | 'held_back' | 'skip'> {
  if (booking.clientConfirmedAt !== null) return 'skip';
  const [risk] = await listVisitRisks(tx, [BookingIdSchema.parse(booking.id)]);
  if (risk?.band !== 'high') return 'skip';
  if (booking.confirmHeldBackAt !== null) return 'held_back';
  return settings.holdback && inHoldbackShare(booking.id) ? 'held_back' : 'ask';
}

/** A reminder that was queued already: the new link it would have carried goes (`skipped`). */
async function dropLink(
  tx: TenantTx,
  link: { url: string; tokenHash: string } | null,
): Promise<'skipped'> {
  if (link !== null) await deleteBookingManageLink(tx, link.tokenHash);
  return 'skipped';
}

/**
 * The number on the client's consent in force that the business may text now (opted out or
 * not textable ones skipped), the latest first; `null` for none. Reminders go there, not to
 * `clients.phone`: the booking page's phone isn't verified (ADR-0065, S61.2).
 */
export async function textableNumber(tx: TenantTx, clientId: string): Promise<string | null> {
  for (const consent of await listActiveSmsConsentsForClient(tx, clientId)) {
    if ((await smsPermission(tx, consent.phone)) === 'allowed') return consent.phone;
  }
  return null;
}

/**
 * A new reschedule/cancel link for the booking (AC-X-72), stored hashed; like the
 * confirmation's, it changes the booking only before it starts. `null` without the app's address.
 */
async function reminderLink(
  tx: TenantTx,
  tenant: Tenant,
  booking: BookingRow,
  now: Date,
  baseUrl: string | null,
): Promise<{ url: string; tokenHash: string } | null> {
  if (baseUrl === null) return null;
  const token = ManageTokenSchema.parse(randomBytes(32).toString('base64url'));
  const tokenHash = createHash('sha256').update(token).digest('hex');
  await insertBookingManageLink(tx, {
    bookingId: BookingIdSchema.parse(booking.id) satisfies BookingId,
    tokenHash,
    createdAt: now,
  });
  return { url: manageUrl(baseUrl, tenant.slug, token), tokenHash };
}

/**
 * One pass of the reminder job: handles the reminders due now, across businesses, the earliest
 * first, in batches until none is left (a backlog after downtime clears in one pass, up to
 * `REMINDER_BATCHES_PER_PASS` batches). Every reminder handled is removed, queued or skipped,
 * so the next batch lists new ones. Returns how many it queued and skipped.
 */
export async function sendDueReminders(
  db: Database,
  options: ReminderOptions,
): Promise<{ queued: number; skipped: number }> {
  const totals = { queued: 0, skipped: 0 };
  for (let batch = 0; batch < REMINDER_BATCHES_PER_PASS; batch += 1) {
    const due = await listDueBookingReminders(db, options.clock.now(), REMINDER_BATCH);
    for (const reminder of due) {
      totals[await sendDueReminder(db, reminder, options)] += 1;
    }
    if (due.length < REMINDER_BATCH) break;
  }
  return totals;
}
