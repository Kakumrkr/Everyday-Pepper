import {
  AUTONOMY_ACTIONS,
  AutonomyActionSchema,
  BULK_RECIPIENT_LIMIT,
  EARNED_TRUST_STREAK,
  type ActionTrackRecord,
  type AutonomyAction,
  type AutonomyLevel,
  type AutonomyPreset,
  type BusinessAutonomy,
  type LocalDate,
  type Rule,
  type RuleDefaults,
} from '@pepper/contracts';

// The Autonomy page's trust controls in words (S53, ADR-0055): the presets, the standing rules
// read back from the dial and the booking rules, each action's count from the Activity log, and
// the earned-trust offer. Pure, from records only (playbook principle 9). Voice: first person,
// short and plain.

export const PRESET_LABEL: Record<AutonomyPreset, string> = {
  careful: 'Careful',
  balanced: 'Balanced',
  hands_off: 'Hands-off',
};

export const PRESET_HELP: Record<AutonomyPreset, string> = {
  careful: 'I ask before every change and every email.',
  balanced:
    'I ask before new bookings, moves, cancellations and client nudges. Smaller changes I do and tell you; confirmations go on their own.',
  hands_off:
    'I make changes and send their emails on my own, and tell you when I send nudges and offers. Big sends and new rules still wait for you.',
};

/** Each action in a list of standing rules ("I ask you before moves and cancellations"). */
export const ACTION_NOUN: Record<AutonomyAction, string> = {
  'booking.create': 'new bookings',
  'booking.move': 'moves',
  'booking.cancel': 'cancellations',
  'booking_request.accept': 'accepting booking-page requests',
  'time.block': 'blocking time',
  'client_note.save': 'client notes',
  'rule.change': 'new booking rules',
  'task.create': 'to-dos',
  'waitlist.change': 'waitlist changes',
  'message.confirmation': 'confirmation emails',
  'message.rebooking_nudge': 'rebooking nudges',
  'message.waitlist_offer': 'waitlist offers',
  'message.bulk': 'messages to several clients',
  'message.review_request': 'review requests',
};

/** One standing rule and where it is changed. */
export interface StandingRule {
  text: string;
  /** `autonomy`: on this page; `rules`: the Booking rules page. */
  changedOn: 'autonomy' | 'rules';
}

/** "a, b and c" for any number of items. */
function list(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

function capitalised(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** "2 hours", "30 minutes", "1 day", "1 day 2 hours". */
export function durationWords(minutes: number): string {
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  const rest = minutes % 60;
  const parts = [
    days > 0 ? `${String(days)} ${days === 1 ? 'day' : 'days'}` : null,
    hours > 0 ? `${String(hours)} ${hours === 1 ? 'hour' : 'hours'}` : null,
    rest > 0 ? `${String(rest)} ${rest === 1 ? 'minute' : 'minutes'}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? 'no time' : parts.join(' ');
}

const DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** "Dec 24", or "Dec 24 – Dec 26", from local dates. */
function dateRange(start: LocalDate, end: LocalDate): string {
  const first = DATE.format(new Date(`${start}T00:00:00Z`));
  return start === end ? first : `${first} – ${DATE.format(new Date(`${end}T00:00:00Z`))}`;
}

/** Blackouts shown by name; more are counted. */
const BLACKOUTS_SHOWN = 3;

/**
 * The business's standing rules in plain words (S53): what the dial says, grouped by level,
 * the two rules that always ask, and the business-wide booking rules (`null`: the member may
 * not read them, so none are shown). `today` hides blackouts that are over.
 */
export function standingRules(
  autonomy: BusinessAutonomy,
  booking: { rules: readonly Rule[]; defaults: RuleDefaults } | null,
  today: LocalDate,
): StandingRule[] {
  const lines: StandingRule[] = [];
  // A new booking rule never changes: it is said once, on its own line with the bulk lock.
  const dialed = AutonomyActionSchema.options.filter(
    (action) => !('askOnly' in AUTONOMY_ACTIONS[action]),
  );
  if (autonomy.askFirst) {
    lines.push({
      text: 'I ask you before every change, while “Ask me first for everything” is on.',
      changedOn: 'autonomy',
    });
  } else {
    const at = (level: AutonomyLevel) =>
      dialed.filter((action) => autonomy.levels[action] === level).map((a) => ACTION_NOUN[a]);
    const ask = at('ask');
    const notify = at('notify');
    const auto = at('auto');
    if (ask.length > 0)
      lines.push({ text: `I ask you before ${list(ask)}.`, changedOn: 'autonomy' });
    if (notify.length > 0) {
      lines.push({
        text: `${capitalised(list(notify))}: I do them and tell you, with Undo.`,
        changedOn: 'autonomy',
      });
    }
    if (auto.length > 0) {
      lines.push({
        text: `${capitalised(list(auto))}: I just do them and list them in Activity.`,
        changedOn: 'autonomy',
      });
    }
  }
  lines.push({
    text: `A message to more than ${String(BULK_RECIPIENT_LIMIT)} clients, and a new booking rule, always wait for your OK.`,
    changedOn: 'autonomy',
  });
  if (booking === null) return lines;

  const own = booking.rules.filter((rule) => rule.staffMemberId === null);
  const one = <T extends Rule['type']>(type: T) =>
    own.find((rule): rule is Extract<Rule, { type: T }> => rule.type === type);
  const notice = one('minimum_notice')?.params.minutes ?? booking.defaults.minimumNoticeMinutes;
  const advance = one('maximum_advance')?.params.days ?? booking.defaults.maximumAdvanceDays;
  lines.push({
    text:
      notice === 0
        ? `Clients can book right up to the start, up to ${String(advance)} days ahead.`
        : `Clients book at least ${durationWords(notice)} ahead, up to ${String(advance)} days ahead.`,
    changedOn: 'rules',
  });
  const cap = one('max_bookings_per_day')?.params.count ?? booking.defaults.maxBookingsPerDay;
  if (cap !== null) {
    lines.push({
      text: `At most ${String(cap)} ${cap === 1 ? 'booking' : 'bookings'} a day.`,
      changedOn: 'rules',
    });
  }
  const closed = own
    .filter(
      (rule): rule is Extract<Rule, { type: 'blackout_window' }> => rule.type === 'blackout_window',
    )
    .filter((rule) => rule.params.endDate >= today)
    .sort((a, b) => a.params.startDate.localeCompare(b.params.startDate));
  if (closed.length > 0) {
    const shown = closed
      .slice(0, BLACKOUTS_SHOWN)
      .map((rule) => dateRange(rule.params.startDate, rule.params.endDate));
    const more = closed.length - shown.length;
    lines.push({
      text: `No bookings on ${list(more > 0 ? [...shown, `${String(more)} more`] : shown)}.`,
      changedOn: 'rules',
    });
  }
  return lines;
}

/** An action's count from the Activity log (S53): "Done 12 times in the last 30 days". */
export function trackLine(record: ActionTrackRecord | undefined): string {
  const done = record?.doneLast30Days ?? 0;
  if (done === 0) return 'Not done in the last 30 days.';
  return `Done ${done === 1 ? 'once' : `${String(done)} times`} in the last 30 days.`;
}

const LEVEL_RANK: Record<AutonomyLevel, number> = { ask: 0, notify: 1, auto: 2 };

const OFFER_ASK: Record<AutonomyLevel, string> = {
  ask: '',
  notify: 'Want me to do it and tell you, without waiting for your OK?',
  auto: 'Want me to just do it? It will still be listed in Activity.',
};

/**
 * The earned-trust offer for an action (S53), or `null`: only while the offer still gives more
 * room than the action has now (a change since the count was read makes it moot).
 */
export function offerLine(
  record: ActionTrackRecord | undefined,
  level: AutonomyLevel,
): { text: string; to: AutonomyLevel } | null {
  const offer = record?.offer ?? null;
  if (offer === null || LEVEL_RANK[offer] <= LEVEL_RANK[level]) return null;
  const streak = Math.max(record?.correctInARow ?? 0, EARNED_TRUST_STREAK);
  return {
    text: `I’ve done this ${String(streak)} times in a row without a mistake. ${OFFER_ASK[offer]}`,
    to: offer,
  };
}
