import {
  ChatFallbackSchema,
  type ChatFallback,
  type ScreenLink,
  type TurnStopReason,
} from '@pepper/contracts';

// The deterministic fallback reply (playbook principle 13, AC-X-2): when a turn can't finish,
// the member gets a plain, fixed sentence for the reason, what this turn already did (from the
// recorded tool outcomes, never from a model), and a link to the screen where they can do it
// themselves. No model is involved, so it works exactly when the model doesn't.

const REASONS: Record<Exclude<TurnStopReason, 'answered'>, string> = {
  step_limit: 'This took more steps than I take in one go, so I stopped.',
  time_limit: 'This took longer than I allow myself, so I stopped.',
  provider_unavailable: 'I can’t reach my AI service right now.',
  provider_refused: 'I can’t help with that request.',
  budget_exhausted:
    'Your business has used this month’s AI allowance, so I’m paused until next month.',
  ai_off: 'The AI assistant is switched off here.',
  cancelled: 'Stopped, as you asked.',
  interrupted: 'I was interrupted before I could finish.',
  internal: 'Something went wrong on my side.',
};

const SCREENS: { link: ScreenLink; words: RegExp }[] = [
  {
    link: { label: 'To-dos', href: '/' },
    words: /\b(to-?dos?|remind|reminder|task|follow[- ]?up|call back)\b/i,
  },
  {
    link: { label: 'Clients', href: '/clients' },
    words: /\b(client|customer|contact|profile)s?\b/i,
  },
  {
    link: { label: 'Team', href: '/team' },
    words: /\b(team|staff|hours|time off|\w*days? off|vacation)\b/i,
  },
  {
    link: { label: 'Services', href: '/services' },
    words: /\b(service|price|menu)s?\b/i,
  },
];
const CALENDAR: ScreenLink = { label: 'Calendar', href: '/calendar' };

/** The screen that matches what the member asked (the calendar when nothing else does). */
export function screenFor(message: string): ScreenLink {
  return SCREENS.find((screen) => screen.words.test(message))?.link ?? CALENDAR;
}

/** What one tool call of the turn came to, as the fallback reports it. */
export interface DoneSoFar {
  status: 'done' | 'awaiting_approval';
  summary: string;
}

/** The fallback for a turn that stopped for `reason`. */
export function fallbackFor(
  reason: Exclude<TurnStopReason, 'answered'>,
  context: { message: string; done: readonly DoneSoFar[] },
): ChatFallback {
  const lines = [REASONS[reason]];
  const done = context.done.filter((each) => each.status === 'done');
  const waiting = context.done.filter((each) => each.status === 'awaiting_approval');
  if (done.length > 0)
    lines.push(`Already done: ${clip(done.map((each) => each.summary).join(' '))}`);
  if (waiting.length > 0) {
    lines.push(
      `Waiting for your OK on the card: ${clip(waiting.map((each) => each.summary).join(' '))}`,
    );
  }
  const link =
    reason === 'cancelled' || reason === 'provider_refused' ? null : screenFor(context.message);
  if (link !== null)
    lines.push(`You can do it yourself in ${link.label}; everything there works as usual.`);
  return ChatFallbackSchema.parse({ reason, text: clip(lines.join(' '), 600), link });
}

function clip(text: string, max = 200): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}
