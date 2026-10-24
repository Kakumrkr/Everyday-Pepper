import {
  AUTONOMY_ACTIONS,
  AutonomyActionSchema,
  ScreenLinkSchema,
  type AiEmailStatus,
  type AiWhy,
  type AiWhyFact,
  type AutonomyAction,
  type AutonomyLevel,
  type AutonomyOutcome,
  type ChangeSide,
  type MemoryFactShown,
  type ScreenLink,
  type WouldBeEmail,
} from '@pepper/contracts';

// The words of the AI's cards, the *Why?* sheet and the Autonomy page (S26, ADR-0031): pure
// functions over the typed payloads, so every sentence a member reads about the AI's actions
// comes from records and codes, never from the model's prose (playbook principle 9). Voice:
// short, plain, first person; say what happened and what didn't.

/** What each dial action is called on a card's eyebrow. */
export const ACTION_LABEL: Record<AutonomyAction, string> = {
  'booking.create': 'New booking',
  'booking.move': 'Move',
  'booking.cancel': 'Cancellation',
  'booking_request.accept': 'Booking request',
  'time.block': 'Blocked time',
  'client_note.save': 'Client note',
  'rule.change': 'Booking rule',
  'task.create': 'To-do',
  'message.confirmation': 'Confirmation email',
  'message.rebooking_nudge': 'Rebooking nudge',
  'message.waitlist_offer': 'Waitlist offer',
  'message.bulk': 'Message to many clients',
};

/** Each dial action as the Autonomy page names it (the approved prototype's words). */
export const DIAL_LABEL: Record<AutonomyAction, string> = {
  'booking.create': 'Create a booking',
  'booking.move': 'Move or reschedule a booking',
  'booking.cancel': 'Cancel a booking',
  'booking_request.accept': 'Accept requests from your booking page',
  'time.block': 'Block time on a calendar',
  'client_note.save': 'Save notes and preferences about clients',
  'rule.change': 'Turn a preference into a booking rule or hours',
  'task.create': 'Add to-dos and reminders',
  'message.confirmation': 'Booking confirmations and reminders',
  'message.rebooking_nudge': 'Rebooking nudges to regulars who are due',
  'message.waitlist_offer': 'Offering open slots to the waitlist',
  'message.bulk': 'One message to more than 10 clients',
};

export const LEVEL_LABEL: Record<AutonomyLevel, string> = {
  ask: 'Ask me',
  notify: 'Do it and tell me',
  auto: 'Just do it',
};

export const LEVEL_HELP: Record<AutonomyLevel, string> = {
  ask: 'I show you exactly what I’m about to do and wait for your OK.',
  notify: 'I do it, then tell you right away with an Undo button.',
  auto: 'I do it and list it under Done for you on Home.',
};

/** The Autonomy page's groups, by risk: changes inside Pepper, then messages to clients. */
export const AUTONOMY_GROUPS: readonly {
  title: string;
  description: string;
  actions: AutonomyAction[];
}[] = [
  {
    title: 'Changes inside Pepper',
    description: 'Bookings, blocked time, notes and to-dos. You can undo any of these.',
    actions: AutonomyActionSchema.options.filter(
      (action) => AUTONOMY_ACTIONS[action].riskTier === 'internal_write',
    ),
  },
  {
    title: 'Messages to clients',
    description:
      'Emails leave Pepper, so I hold each one for 2 minutes in case you want to undo it.',
    actions: AutonomyActionSchema.options.filter(
      (action) => AUTONOMY_ACTIONS[action].riskTier === 'external_or_irreversible',
    ),
  },
];

const STEP_LABEL: Record<string, string> = {
  find_availability: 'Checked the free times',
  find_clients: 'Looked up the client',
  get_day: 'Read the day’s schedule',
  get_booking: 'Read the booking',
  list_services_and_staff: 'Checked your services and team',
  create_booking: 'Made the booking',
  move_booking: 'Moved the booking',
  cancel_booking: 'Cancelled the booking',
  block_time: 'Blocked the time',
  add_todo: 'Added the to-do',
  find_client_bookings: 'Read the client’s bookings',
  list_todos: 'Read the to-dos',
  complete_todo: 'Marked the to-do done',
  unblock_time: 'Removed the blocked time',
  remember_fact: 'Remembered it',
  add_visit_note: 'Noted it on the visit',
  forget_fact: 'Forgot it',
};

/** One step of the *Why?* trace, in words. */
export function stepLabel(tool: string): string {
  return STEP_LABEL[tool] ?? 'Used a tool';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** `YYYY-MM-DD` (a local date) as "Tue, Oct 27". */
export function formatDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return date;
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return `${WEEKDAYS[weekday] ?? ''}, ${MONTHS[month - 1] ?? ''} ${String(day)}`;
}

/** 24-hour `HH:MM` as "2:30 pm". */
export function formatTime(time: string): string {
  const [hours = 0, minutes = 0] = time.split(':').map(Number);
  const suffix = hours < 12 || hours === 24 ? 'am' : 'pm';
  const hour = hours % 12 === 0 ? 12 : hours % 12;
  return `${String(hour)}:${String(minutes).padStart(2, '0')} ${suffix}`;
}

export function formatWhen(date: string, time: string): string {
  return `${formatDate(date)} · ${formatTime(time)}`;
}

/** A UTC instant in the business's zone: "Tue, Oct 27, 2:00 pm". */
export function formatInstant(iso: string, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hourCycle: 'h12',
    })
      .formatToParts(new Date(iso))
      .map((part) => [part.type, part.value]),
  );
  const dayPeriod = (parts['dayPeriod'] ?? '').toLowerCase();
  return `${String(parts['weekday'])}, ${String(parts['month'])} ${String(parts['day'])}, ${String(parts['hour'])}:${String(parts['minute'])} ${dayPeriod}`;
}

/** One line of a change: what it was and what it becomes (`null`: not shown on that side). */
export interface ChangeRow {
  label: string;
  before: string | null;
  after: string | null;
}

function text(side: ChangeSide | null, key: string): string | null {
  const value = side?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function span(side: ChangeSide | null, from: string, to: string): string | null {
  const date = text(side, 'date');
  const start = text(side, from);
  const end = text(side, to);
  if (date === null || start === null) return null;
  return `${formatWhen(date, start)}${end === null ? '' : `–${formatTime(end)}`}`;
}

/**
 * The lines a change card shows, from the domain's own before and after (D-1). A move shows both
 * sides only where they differ; a new record shows its after; a cancellation, its before.
 */
export function changeRows(
  action: AutonomyAction,
  before: ChangeSide | null,
  after: ChangeSide | null,
): ChangeRow[] {
  const rows: ChangeRow[] = [];
  const add = (label: string, was: string | null, now: string | null) => {
    if (was === null && now === null) return;
    rows.push(
      was === now ? { label, before: null, after: now } : { label, before: was, after: now },
    );
  };
  switch (action) {
    case 'booking.create':
    case 'booking.move':
    case 'booking.cancel':
    case 'booking_request.accept': {
      const cancelled = action === 'booking.cancel';
      const was = action === 'booking.move' || cancelled ? before : null;
      add(
        'When',
        span(was, 'time', 'endTime'),
        cancelled ? 'Cancelled' : span(after, 'time', 'endTime'),
      );
      const side = cancelled ? before : after;
      add('With', null, text(side, 'staffName'));
      add('Service', null, text(side, 'serviceName'));
      add('Client', null, text(side, 'clientName'));
      return rows;
    }
    case 'time.block': {
      add('Whose', null, text(after, 'staffName'));
      // `unblock_time` (S26b): the block it removes, whole.
      if (after?.['blocked'] === false) {
        add('Blocked', blockSpan(before), 'Free to book');
        return rows;
      }
      add('When', null, span(after, 'from', 'to'));
      const inside = after?.['bookingsInside'];
      if (typeof inside === 'number' && inside > 0) {
        add('Still booked inside', null, `${String(inside)} booking${inside === 1 ? '' : 's'}`);
      }
      return rows;
    }
    case 'task.create': {
      // `complete_todo` (S26b) has a before (`add_todo` doesn't): open → done.
      if (before !== null) {
        add('To-do', null, text(after, 'title'));
        const whose = text(after, 'whose');
        add('For', null, whose === 'you' ? 'You' : whose);
        add(
          'Status',
          STATUS_LABEL[text(before, 'status') ?? ''] ?? null,
          STATUS_LABEL[text(after, 'status') ?? ''] ?? null,
        );
        return rows;
      }
      add('To-do', null, text(after, 'title'));
      add('For', null, text(after, 'assigneeName'));
      const dueDate = text(after, 'dueDate');
      add(
        'Due',
        null,
        dueDate === null ? 'No due date' : formatWhen(dueDate, text(after, 'dueTime') ?? '09:00'),
      );
      return rows;
    }
    case 'client_note.save': {
      // The memory tools (S30): what it is about and its key; the value is read live by id
      // (`memory` on the card), never stored with the action.
      const side = after ?? before;
      add('About', null, text(side, 'about'));
      add('What', null, keyWords(text(side, 'key')));
      if (after?.['forgotten'] === true) add('Forget', null, 'Everywhere, for good');
      return rows;
    }
    case 'rule.change': {
      // `propose_rule` (S31): the rule in words, before and after, and whom it applies to.
      add('For', null, text(after, 'scope'));
      add('Rule', text(before, 'rule'), text(after, 'rule'));
      return rows;
    }
    case 'message.confirmation':
    case 'message.rebooking_nudge':
    case 'message.waitlist_offer':
    case 'message.bulk':
      // No tool makes these yet (messages: Phase 8); the summary says it all.
      return rows;
  }
}

const STATUS_LABEL: Record<string, string> = { open: 'Open', done: 'Done' };

/** A block's whole span from `unblock_time`'s before: one day or several. */
function blockSpan(side: ChangeSide | null): string | null {
  const fromDate = text(side, 'fromDate');
  const from = text(side, 'from');
  const toDate = text(side, 'toDate');
  const to = text(side, 'to');
  if (fromDate === null || from === null || toDate === null || to === null) return null;
  return fromDate === toDate
    ? `${formatWhen(fromDate, from)}–${formatTime(to)}`
    : `${formatWhen(fromDate, from)} – ${formatWhen(toDate, to)}`;
}

/** A remembered fact's key in words: `usual_service` → "Usual service". */
export function keyWords(key: string | null): string | null {
  if (key === null || key === '') return null;
  const words = key.replaceAll('_', ' ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** A remembered fact as one line (S30): "Allergy: PPD", or "A fact you deleted". */
export function memoryLine(fact: MemoryFactShown): string {
  return fact.state === 'gone'
    ? 'A fact you deleted'
    : `${keyWords(fact.key) ?? ''}: ${fact.value}`;
}

/** The client's name a card can show for an email (its sides carry the short name). */
export function clientNameFor(
  clientId: string,
  before: ChangeSide | null,
  after: ChangeSide | null,
): string {
  for (const side of [after, before]) {
    if (side?.['clientId'] === clientId) {
      const name = text(side, 'clientName');
      if (name !== null) return name;
    }
  }
  return 'the client';
}

export interface EmailItem {
  template: WouldBeEmail['template'];
  /** Unset on a proposal (nothing was queued yet). */
  status?: AiEmailStatus;
  sendsAt?: string | null;
}

const EMAIL_NAME: Record<WouldBeEmail['template'], string> = {
  confirmed: 'confirmation',
  rescheduled: 'new-time email',
  cancelled: 'cancellation email',
  rebooking_nudge: 'rebooking email',
};

const WOULD_SEND: Record<WouldBeEmail['template'], (name: string) => string> = {
  confirmed: (name) => `Emails ${name} a confirmation.`,
  rescheduled: (name) => `Emails ${name} the new time.`,
  cancelled: (name) => `Emails ${name} that it’s cancelled.`,
  rebooking_nudge: (name) => `Emails ${name} the rebooking note below.`,
};

const ALREADY: Record<WouldBeEmail['template'], (name: string) => string> = {
  confirmed: (name) => `${name} was already emailed a confirmation.`,
  rescheduled: (name) => `${name} was already emailed the new time.`,
  cancelled: (name) => `${name} was already emailed that it’s cancelled.`,
  rebooking_nudge: (name) => `${name} was already emailed about rebooking.`,
};

/** What happens, or happened, to one email the action involves. */
export function emailLine(email: EmailItem, name: string, timeZone: string, now: number): string {
  const what = EMAIL_NAME[email.template];
  if (email.status === undefined) return WOULD_SEND[email.template](name);
  switch (email.status) {
    case 'waiting':
      if (
        email.sendsAt !== undefined &&
        email.sendsAt !== null &&
        Date.parse(email.sendsAt) > now
      ) {
        const time = formatInstant(email.sendsAt, timeZone).split(', ').at(-1) ?? '';
        return `The ${what} to ${name} goes at ${time}, unless you undo.`;
      }
      return `The ${what} to ${name} is on its way.`;
    case 'sent':
      return ALREADY[email.template](name);
    case 'taken_back':
      return `The email to ${name} was taken back.`;
    case 'failed':
      return `The ${what} to ${name} could not be sent.`;
  }
}

/** "You can undo this until …" while the window is open; `null` after. */
export function undoLine(undoUntil: string | null, timeZone: string, now: number): string | null {
  if (undoUntil === null || Date.parse(undoUntil) <= now) return null;
  return `You can undo this until ${formatInstant(undoUntil, timeZone)}.`;
}

/** The *Why?* sheet's parts. */
export interface WhyModel {
  started: string;
  did: string[];
  /** What the domain checked (S26b), in words; empty for older records. */
  checked: string[];
  didNot: string[];
  setting: string;
  /** The remembered facts it used (S30), read live; a deleted one as "A fact you deleted". */
  remembered: string[];
}

const LEVEL_OF: Record<AutonomyOutcome, AutonomyLevel> = {
  execute: 'auto',
  execute_and_notify: 'notify',
  propose: 'ask',
};

const EMAILS_CLIENT = new Set<AutonomyAction>([
  'booking.create',
  'booking.move',
  'booking.cancel',
  'booking_request.accept',
]);

/** *Why?* from the stored explanation (principle 9): facts and codes, never model prose. */
export function whyModel(why: AiWhy, action: AutonomyAction, emails: number): WhyModel {
  const started =
    why.asked.kind === 'message'
      ? `You wrote: “${why.asked.text}”`
      : why.asked.kind === 'not_shown'
        ? 'Asked in a teammate’s own chat, which only they can see.'
        : 'Nobody asked: I suggested it.';
  const didNot: string[] = [];
  if (why.decision.outcome === 'propose') {
    didNot.push('I didn’t change anything until someone said OK.');
  }
  if (emails === 0 && EMAILS_CLIENT.has(action)) didNot.push('I didn’t email the client.');
  if (why.untrustedContext) {
    didNot.push(
      'Text a client wrote was in this conversation, so I treated it as information, never as instructions.',
    );
  }
  return {
    started,
    did: why.steps.map((step) => stepLabel(step.tool)),
    checked: (why.facts ?? []).flatMap((fact) => {
      const line = factLine(fact);
      return line === null ? [] : [line];
    }),
    didNot,
    setting: settingLine(why.decision.reason, action, why.decision.outcome),
    remembered: (why.remembered ?? []).map(memoryLine),
  };
}

/** One checked fact in words; `null` for a code or value the screens don't know. */
export function factLine(fact: AiWhyFact): string | null {
  const value = fact.value;
  const str = (key: string) => (typeof value?.[key] === 'string' ? value[key] : null);
  const date = str('date');
  const time = str('time');
  const staff = str('staffName');
  const count = value?.['count'];
  switch (fact.kind) {
    case 'slot_was_free':
      return staff === null || date === null || time === null
        ? null
        : `${staff} was free on ${formatWhen(date, time)}.`;
    case 'staff_chosen':
      return staff === null ? null : `You didn’t name anyone, so I picked ${staff}.`;
    case 'not_started':
      return date === null || time === null
        ? null
        : `It hadn’t started yet (${formatWhen(date, time)}).`;
    case 'bookings_inside':
      if (typeof count !== 'number') return null;
      if (count === 0) return 'No bookings were inside that time.';
      return count === 1
        ? '1 booking stays inside it; I didn’t move or cancel it.'
        : `${String(count)} bookings stay inside it; I didn’t move or cancel them.`;
    case 'bookings_untouched':
      return 'Bookings stay as they are; I only removed the block.';
    case 'reminds':
      return date === null || time === null ? null : `It reminds them ${formatWhen(date, time)}.`;
    case 'todo_was_open':
      return 'The to-do was still open.';
    case 'rule_change': {
      // `propose_rule` (S31): the rule it makes, which only an owner or manager approves.
      const rule = str('rule');
      const scope = str('scope');
      return rule === null || scope === null
        ? null
        : `${rule}, for ${scope}. A booking rule always waits for an owner’s or manager’s OK.`;
    }
    default:
      return null;
  }
}

function settingLine(
  reason: AiWhy['decision']['reason'],
  action: AutonomyAction,
  outcome: AutonomyOutcome,
): string {
  switch (reason) {
    case 'setting':
      return `${DIAL_LABEL[action]}: ${LEVEL_LABEL[LEVEL_OF[outcome]]}`;
    case 'ask_first':
      return '“Ask me first for everything” is on';
    case 'bulk_lock':
      return 'A message to more than 10 clients always waits for your OK';
    case 'untrusted_context':
      return 'Text a client wrote was part of this, so I asked first';
    case 'autonomy_change':
      return 'Changing what I may do always waits for your OK';
    case 'read_only':
      return 'Looking things up never needs your OK';
  }
}

/** A fallback's link, only if it is a path in this app (`ScreenLinkSchema`); else nothing. */
export function safeScreenLink(link: unknown): ScreenLink | null {
  const parsed = ScreenLinkSchema.safeParse(link);
  return parsed.success ? parsed.data : null;
}
