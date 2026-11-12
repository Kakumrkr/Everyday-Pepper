import { createHash, randomBytes } from 'node:crypto';
import {
  BookingIdSchema,
  ClientIdSchema,
  ManageTokenSchema,
  OutboxDedupeKeySchema,
  ReminderSettingsSchema,
  smsSendableAt,
  TenantIdSchema,
  fromZoned,
  toZoned,
  type BookingId,
  type ReminderKind,
  type ReminderSettings,
} from '@pepper/contracts';
import { queueEmail, queueSms, smsPermission, type Clock } from '@pepper/core';
import {
  findCurrentTenant,
  hasReminderText,
  insertBookingManageLink,
  insertBookingText,
  listActiveSmsConsentsForClient,
  listBookings,
  listDueBookingReminders,
  lockBooking,
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
import { manageUrl, reminderEmail } from '../emails.js';
import { reminderText } from '../texts.js';
import { emailDetailsOf } from './notices.js';

// Booking reminders (W6, AC-W6-1, ADR-0025; S62 AC-X-70…72): every confirmed booking has its
// reminders planned in the booking's own transaction, so a cancelled booking never keeps one
// and a moved booking's reminders move with it. Two kinds: the day before (by text when the
// client said yes and the business may text them, else by email) and the same day (by text
// only), each at a time kept out of the night in the business's zone. A booking made under 24 h
// ahead still gets the same-day text; one made under its lead gets none (its confirmation has
// just been sent). The worker's reminder job sends what is due (`sendDueReminders`): it checks
// the booking again under its lock and queues the text or email in the outbox in the same
// transaction that takes the reminder, so each is queued at most once.

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
  if (kind === 'day_before') {
    return settings.dayBefore ? keptInHours(timeZone, startsAt - REMINDER_LEAD_MS) : null;
  }
  if (!settings.sameDay || !settings.texts) return null;
  const due = keptInHours(timeZone, startsAt - settings.sameDayLeadHours * HOUR_MS);
  if (!sameLocalDay(timeZone, due, startsAt)) return null;
  return due <= startsAt - SAME_DAY_MIN_NOTICE_MS ? due : null;
}

const KINDS: readonly ReminderKind[] = ['day_before', 'same_day'];

/** A business's reminder settings, each missing or unreadable field at its default. */
export function reminderSettingsOf(tenant: Pick<Tenant, 'reminderSettings'>): ReminderSettings {
  const parsed = ReminderSettingsSchema.safeParse(tenant.reminderSettings);
  return parsed.success ? parsed.data : ReminderSettingsSchema.parse({});
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
}

async function keepRemindersOf(
  tx: TenantTx,
  row: BookingRow,
  now: number,
  timeZone: string,
  settings: ReminderSettings,
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
    } else {
      await removeBookingReminder(tx, bookingId, kind);
    }
  }
}

/** The most upcoming bookings one settings change re-plans. */
export const REPLAN_LIMIT = 5000;
/** How far ahead a settings change re-plans. */
const REPLAN_HORIZON_MS = 400 * 24 * HOUR_MS;

/**
 * Re-plans every upcoming confirmed booking's reminders with `settings` (a settings change,
 * AC-X-75), in the change's transaction. Returns how many bookings it looked at.
 */
export async function replanUpcomingReminders(
  tx: TenantTx,
  timeZone: string,
  settings: ReminderSettings,
  now: number,
): Promise<number> {
  const upcoming = await listBookings(tx, {
    from: new Date(now),
    to: new Date(now + REPLAN_HORIZON_MS),
    status: 'confirmed',
    limit: REPLAN_LIMIT,
  });
  for (const row of upcoming) {
    if (row.startsAt.getTime() > now) await keepRemindersOf(tx, row, now, timeZone, settings);
  }
  return upcoming.length;
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
    const details = await emailDetailsOf(tx, tenant, booking);
    const phone =
      options.texts === true && settings.texts ? await textableNumber(tx, booking.clientId) : null;
    if (phone === null && (due.kind === 'same_day' || details.email === '')) return 'skipped';
    const link = await reminderLink(tx, tenant, booking, now, options.baseUrl ?? null);
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
            link,
            askToConfirm: booking.clientConfirmedAt === null,
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
      if (id === undefined) return 'skipped';
      await insertBookingText(tx, {
        id,
        clientId,
        bookingId,
        kind: due.kind,
        startsAt: booking.startsAt,
        createdAt: now,
      });
      return 'queued';
    }
    const queued = await queueEmail(tx, reminderEmail(details, link), {
      key: options.key,
      // One reminder per booking and start, even if a reminder were somehow planned twice.
      dedupeKey: OutboxDedupeKeySchema.parse(`booking.reminder:${bookingId}:${String(startsAt)}`),
      now,
    });
    return queued === undefined ? 'skipped' : 'queued';
  });
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
): Promise<string | null> {
  if (baseUrl === null) return null;
  const token = ManageTokenSchema.parse(randomBytes(32).toString('base64url'));
  await insertBookingManageLink(tx, {
    bookingId: BookingIdSchema.parse(booking.id) satisfies BookingId,
    tokenHash: createHash('sha256').update(token).digest('hex'),
    createdAt: now,
  });
  return manageUrl(baseUrl, tenant.slug, token);
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
