import {
  PILOT_METRIC_TARGETS,
  type PilotMetric,
  type PilotMetricKey,
  type PilotMetricStatus,
  type PilotMetrics,
} from '@pepper/contracts';

// The pilot metrics page's words (S59.4, AC-X-47…49): each metric's name, number, target and
// judgement, in the console's plain words. The api computes; these only say things.

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
  support_requests: ['bookable business', 'bookable businesses'],
  first_reply_time: ['answered request', 'answered requests'],
};

/** The groups of the page, in order. */
export const PILOT_METRIC_GROUPS: readonly { title: string; keys: readonly PilotMetricKey[] }[] = [
  {
    title: 'Getting started',
    keys: ['onboarding_completion', 'time_to_bookable', 'time_to_first_booking'],
  },
  { title: 'Booking page', keys: ['booking_completion', 'code_step_drop_off'] },
  { title: 'Visits', keys: ['no_show_rate', 'fill_rate', 'waitlist_conversion'] },
  { title: 'Support', keys: ['support_requests'] },
];

/** Minutes in words: "45 s", "9 min", "1 h 36 min", "1 d 2 h". */
export function minutesWords(minutes: number): string {
  if (minutes < 1) return `${String(Math.round(minutes * 60))} s`;
  const whole = Math.round(minutes);
  if (whole < 60) return `${String(whole)} min`;
  if (whole < 24 * 60) {
    const hours = Math.floor(whole / 60);
    const rest = whole % 60;
    return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`;
  }
  const days = Math.floor(whole / (24 * 60));
  const hours = Math.round((whole % (24 * 60)) / 60);
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
  return `${numberWords(metric.value)} a week`;
}

/** The scorecard target in words ("Target at least 80%", "Median at most 10 min"). */
export function targetWords(key: PilotMetricKey): string {
  if (key === 'no_show_rate') return 'Target: below each owner’s own rate';
  if (key === 'fill_rate') return 'Target set after week 2';
  const { unit, target } = PILOT_METRIC_TARGETS[key];
  if (target === null) return 'Tracked';
  const bound = target.kind === 'at_least' ? 'at least' : 'at most';
  const value = metricValueWords({ key, value: target.value });
  if (key === 'first_reply_time') return `Target: median ${bound} ${value}, all the same day`;
  if (unit === 'minutes') return `Target: median ${bound} ${value}`;
  if (unit === 'per_business_week')
    return `Target: ${bound} ${String(target.value)} a business a week`;
  return `Target: ${bound} ${value}`;
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
