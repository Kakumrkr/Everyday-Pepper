import { addDays, formatDate, fromZoned, parseDate, toZoned } from '@pepper/contracts';
import { clockLabel } from './setup';

// The To-dos card on Home (S21, ADR-0026): due times are entered and shown on the business's
// clock, like bookings. The api decides who may see and assign what; this only shapes it.

/** A member as the card needs them (`Member` fits). */
export interface TeamMember {
  userId: string;
  name: string;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** When a due date without a time is due: 9:00 AM on the business's clock. */
export const DEFAULT_DUE_TIME = '09:00';

/**
 * The due instant (UTC ISO) of a date and optional time typed on the business's clock:
 * `dueAt` `null` with no date; not `ok` for a malformed one.
 */
export function dueAtFrom(
  timeZone: string,
  day: string,
  time: string,
): { ok: true; dueAt: string | null } | { ok: false } {
  if (day === '') return { ok: true, dueAt: null };
  const clock = time === '' ? DEFAULT_DUE_TIME : time;
  if (!DATE_PATTERN.test(day) || !TIME_PATTERN.test(clock)) return { ok: false };
  const [hours = 0, minutes = 0] = clock.split(':').map(Number);
  const dueAt = new Date(fromZoned(timeZone, parseDate(day), hours * 60 + minutes)).toISOString();
  return { ok: true, dueAt };
}

/** The date and time inputs' values for a due instant (to edit it), on the business's clock. */
export function dueInputs(timeZone: string, dueAt: string | null): { day: string; time: string } {
  if (dueAt === null) return { day: '', time: '' };
  const zoned = toZoned(timeZone, Date.parse(dueAt));
  const hh = String(Math.floor(zoned.minuteOfDay / 60)).padStart(2, '0');
  const mm = String(zoned.minuteOfDay % 60).padStart(2, '0');
  return { day: formatDate(zoned), time: `${hh}:${mm}` };
}

/**
 * When a task is due, in words on the business's clock: `Today, 2:00 PM`, `Tomorrow, 9:00 AM`,
 * `Yesterday, …` or `Tue, Nov 3, 9:00 AM`; `overdue` once that time has passed at `now`.
 */
export function dueLabel(
  timeZone: string,
  dueAt: string,
  now: number,
): { text: string; overdue: boolean } {
  const due = toZoned(timeZone, Date.parse(dueAt));
  const today = formatDate(toZoned(timeZone, now));
  const day = formatDate(due);
  const hh = String(Math.floor(due.minuteOfDay / 60)).padStart(2, '0');
  const mm = String(due.minuteOfDay % 60).padStart(2, '0');
  const time = clockLabel(`${hh}:${mm}`);
  const named: Record<string, string> = {
    [today]: 'Today',
    [formatDate(addDays(parseDate(today), 1))]: 'Tomorrow',
    [formatDate(addDays(parseDate(today), -1))]: 'Yesterday',
  };
  const dayText =
    named[day] ??
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    }).format(new Date(`${day}T12:00:00Z`));
  return { text: `${dayText}, ${time}`, overdue: Date.parse(dueAt) <= now };
}

/** Who a task is for, as the card shows it: `You`, a member's name, or `Team` (no one). */
export function assigneeLabel(
  assigneeUserId: string | null,
  me: string,
  members: readonly TeamMember[] | null,
): string {
  if (assigneeUserId === null) return 'Team';
  if (assigneeUserId === me) return 'You';
  return members?.find((member) => member.userId === assigneeUserId)?.name ?? 'A colleague';
}

/** The choices of the assignee picker (owners and managers): me, everyone else, the team. */
export function assigneeChoices(
  me: string,
  members: readonly TeamMember[],
): { value: string; label: string }[] {
  const others = members
    .filter((member) => member.userId !== me)
    .map((member) => ({ value: member.userId, label: member.name }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return [{ value: me, label: 'Me' }, ...others, { value: TEAM, label: 'Anyone on the team' }];
}

/** The picker's value for "no one in particular". */
export const TEAM = 'team';

/** The `assigneeUserId` for a picker value. */
export function assigneeFromChoice(value: string): string | null {
  return value === TEAM ? null : value;
}
