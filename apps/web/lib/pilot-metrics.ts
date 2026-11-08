import {
  PILOT_METRIC_TARGETS,
  type PilotMetricTarget,
  type PilotMetric,
  type PilotMetricKey,
  type PilotMetricStatus,
  type PilotMetrics,
} from '@pepper/contracts';
import { formatMoney, type TrendTone } from '@pepper/ui';

// The pilot metrics page's words (S59.4, S59.4.2, AC-X-47…53): each metric's name, number,
// target, judgement and change against the period before, in the console's plain words. The
// api computes; these only say things.

export const PILOT_METRICS_PERIOD_LABEL: Readonly<Record<7 | 30, string>> = {
  7: 'Last 7 days',
  30: 'Last 30 days',
};

/** The period a `?days=` names; anything else is the last 7 days. */
export function metricsDays(value: string | string[] | undefined): 7 | 30 {
  return value === '30' ? 30 : 7;
}

export const PILOT_METRIC_LABEL: Readonly<Record<PilotMetricKey, string>> = {
  onboarding_completion: 'Sign-ups that got bookable',
  time_to_bookable: 'Time to bookable',
  time_to_first_booking: 'Time to first booking',
  booking_completion: 'Booking page visits that booked',
  code_step_drop_off: 'Left at the email code',
  no_show_rate: 'No-shows',
  fill_rate: 'Cancelled slots refilled',
  waitlist_conversion: 'Waitlist offers claimed',
  support_requests: 'Support requests',
  first_reply_time: 'First reply',
  weekly_active_owners: 'Owners active 4+ days a week',
  cards_vs_chat: 'Done from a card, not chat',
  ai_approval_rate: 'Proposals approved',
  ai_correction_rate: 'Proposals corrected',
  undo_rate: 'AI actions undone as wrong',
  ai_cost: 'AI cost a business',
  rebook_rate: 'Clients rebooked in time',
};

/** What each metric's cases are, for "from 12 sign-ups". */
const SAMPLE_NOUN: Readonly<Record<PilotMetricKey, [string, string]>> = {
  onboarding_completion: ['sign-up', 'sign-ups'],
  time_to_bookable: ['business', 'businesses'],
  time_to_first_booking: ['business', 'businesses'],
  booking_completion: ['visit', 'visits'],
  code_step_drop_off: ['visit at the code', 'visits at the code'],
  no_show_rate: ['past visit', 'past visits'],
  fill_rate: ['cancelled slot', 'cancelled slots'],
  waitlist_conversion: ['offer', 'offers'],
  support_requests: ['business', 'businesses'],
  first_reply_time: ['answered request', 'answered requests'],
  weekly_active_owners: ['owner-week', 'owner-weeks'],
  cards_vs_chat: ['action', 'actions'],
  ai_approval_rate: ['proposal', 'proposals'],
  ai_correction_rate: ['proposal', 'proposals'],
  undo_rate: ['AI action', 'AI actions'],
  ai_cost: ['active business', 'active businesses'],
  rebook_rate: ['client due', 'clients due'],
};

/** The groups of the page, in order. */
export const PILOT_METRIC_GROUPS: readonly { title: string; keys: readonly PilotMetricKey[] }[] = [
  {
    title: 'Getting started',
    keys: ['onboarding_completion', 'time_to_bookable', 'time_to_first_booking'],
  },
  { title: 'Booking page', keys: ['booking_completion', 'code_step_drop_off'] },
  { title: 'Owners using Pepper', keys: ['weekly_active_owners', 'cards_vs_chat'] },
  {
    title: 'The AI’s proposals',
    keys: ['ai_approval_rate', 'ai_correction_rate', 'undo_rate', 'ai_cost'],
  },
  {
    title: 'Visits',
    keys: ['no_show_rate', 'fill_rate', 'waitlist_conversion', 'rebook_rate'],
  },
  { title: 'Support', keys: ['support_requests'] },
];

/** Minutes in words: "45 s", "9 min", "1 h 36 min", "1 d 2 h" (each unit rolls over). */
export function minutesWords(minutes: number): string {
  const seconds = Math.round(minutes * 60);
  if (seconds < 60) return `${String(seconds)} s`;
  const whole = Math.round(minutes);
  if (whole < 60) return `${String(whole)} min`;
  if (whole < 24 * 60) {
    const hours = Math.floor(whole / 60);
    const rest = whole % 60;
    return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`;
  }
  const totalHours = Math.round(whole / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours === 0 ? `${String(days)} d` : `${String(days)} d ${String(hours)} h`;
}

function numberWords(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** A metric's number in its unit; "–" without one. */
export function metricValueWords(metric: Pick<PilotMetric, 'key' | 'value'>): string {
  if (metric.value === null) return '–';
  const { unit } = PILOT_METRIC_TARGETS[metric.key];
  if (unit === 'percent') return `${numberWords(metric.value)}%`;
  if (unit === 'minutes') return minutesWords(metric.value);
  if (unit === 'cents') return `${formatMoney(Math.round(metric.value))} a month`;
  return `${numberWords(metric.value)} a week`;
}

function boundWords(target: PilotMetricTarget, key: PilotMetricKey): string {
  const words = (value: number) => metricValueWords({ key, value });
  switch (target.kind) {
    case 'at_least':
      return `at least ${words(target.value)}`;
    case 'at_most':
      return `at most ${words(target.value)}`;
    case 'below':
      return `below ${words(target.value)}`;
    case 'between':
      return `${numberWords(target.min)}–${words(target.max)}`;
  }
}

/** The scorecard target in words ("Target: at least 80%", "Target: median at most 10 min"). */
export function targetWords(key: PilotMetricKey): string {
  if (key === 'no_show_rate') return 'Target: below each owner’s own rate';
  if (key === 'fill_rate') return 'Target set after week 2';
  if (key === 'rebook_rate') return 'Target: 10 points above each owner’s own rate';
  const { unit, target } = PILOT_METRIC_TARGETS[key];
  if (target === null) return 'Tracked';
  const bound = boundWords(target, key);
  if (key === 'first_reply_time') return `Target: median ${bound}, all the same day`;
  if (unit === 'minutes') return `Target: median ${bound}`;
  if (unit === 'per_business_week' && target.kind === 'at_most')
    return `Target: at most ${String(target.value)} a business a week`;
  // The cost is an estimate: every chat turn priced at the strong model's rate.
  if (unit === 'cents') return `Target: ${bound}, priced high`;
  return `Target: ${bound}`;
}

/** The size of a change in a metric's unit: "4.2 pts", "12 min", "0.3", "$0.40". */
function changeWords(key: PilotMetricKey, change: number): string {
  const { unit } = PILOT_METRIC_TARGETS[key];
  if (unit === 'percent') return `${numberWords(change)} pts`;
  if (unit === 'minutes') return minutesWords(change);
  if (unit === 'cents') return formatMoney(Math.round(change));
  return numberWords(change);
}

/**
 * A metric's change against the period before (S59.4.2 top-up), for the kit's `Trend`; `null`
 * when either period has no number to compare.
 */
export function metricTrend(
  metric: PilotMetric,
  days: 7 | 30,
): {
  direction: 'up' | 'down' | 'none';
  tone: TrendTone;
  change: string;
  against: string;
} | null {
  if (metric.trend === null || metric.value === null || metric.previous === null) return null;
  // Both numbers are in tenths: rounding the difference keeps 0.1 + 0.2 from showing 0.30000004.
  const difference = Math.round((metric.value - metric.previous) * 10) / 10;
  return {
    direction: difference > 0 ? 'up' : difference < 0 ? 'down' : 'none',
    tone: difference === 0 ? 'neutral' : metric.trend,
    change: changeWords(metric.key, Math.abs(difference)),
    against: `vs the ${String(days)} days before`,
  };
}

/** "from 12 sign-ups", "from 1 offer". */
export function sampleWords(key: PilotMetricKey, sample: number): string {
  const [one, many] = SAMPLE_NOUN[key];
  return `from ${String(sample)} ${sample === 1 ? one : many}`;
}

export const PILOT_METRIC_STATUS: Readonly<
  Record<PilotMetricStatus, { label: string; tone: 'ok' | 'warn' | 'neutral' }>
> = {
  met: { label: 'On target', tone: 'ok' },
  missed: { label: 'Off target', tone: 'warn' },
  tracked: { label: 'Tracked', tone: 'neutral' },
  not_enough: { label: 'Not enough yet', tone: 'neutral' },
};

/** "2 by email of 6 (33%)"; "None yet" with none. */
export function emailShareWords(byEmail: number, total: number): string {
  if (total === 0) return 'None yet';
  return `${String(byEmail)} by email of ${String(total)} (${String(Math.round((byEmail / total) * 100))}%)`;
}

/** The "By email vs in the app" rows (AC-X-49). */
export function channelRows(
  channels: PilotMetrics['channels'],
): readonly { label: string; value: string }[] {
  const requests = channels.requestsInApp + channels.requestsByEmail;
  const replies = channels.repliesInApp + channels.repliesByEmail;
  const publicRequests = channels.publicByForm + channels.publicByEmail;
  return [
    { label: 'New requests', value: emailShareWords(channels.requestsByEmail, requests) },
    { label: 'Owners’ replies', value: emailShareWords(channels.repliesByEmail, replies) },
    { label: 'Signed out', value: emailShareWords(channels.publicByEmail, publicRequests) },
    {
      label: 'Mail not landed',
      value: `${String(channels.inboundHeld)} held · ${String(channels.inboundIgnored)} ignored · ${String(channels.inboundRefused)} refused`,
    },
  ];
}

/** The first-reply rows beside its median (AC-X-48). */
export function firstReplyRows(
  firstReply: PilotMetrics['firstReply'],
): readonly { label: string; value: string }[] {
  return [
    {
      label: 'Slowest',
      value: firstReply.slowestMinutes === null ? '–' : minutesWords(firstReply.slowestMinutes),
    },
    {
      label: 'Within a day',
      value: `${String(firstReply.answeredWithinDay)} of ${String(firstReply.answered)} answered`,
    },
    {
      label: 'Waiting',
      value:
        firstReply.waiting === 0
          ? 'None'
          : `${String(firstReply.waiting)} (${String(firstReply.waitingOverDay)} over a day)`,
    },
    {
      label: 'Signed out',
      value: `${String(firstReply.publicAnswered)} answered · ${String(firstReply.publicOpen)} open`,
    },
  ];
}
