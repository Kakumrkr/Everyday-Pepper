import type { BadgeTone } from '@pepper/ui';
import type { ClientTexts, SmsConsentSource } from '@pepper/contracts';

// The words of a client's "Text messages" section (S61.2, AC-X-66, AC-X-67): where their texts
// stand in one line, what to do next, and the record behind it ("when did they say yes?").

export interface TextsSummary {
  badge: { text: string; tone: BadgeTone };
  /** The one line: on since when and how, or why they are off. */
  line: string;
  /** What happens next, or what the owner can do. */
  next: string;
}

const HOW: Record<SmsConsentSource, string> = {
  booking_page: 'on your booking page',
  member_settings: 'in their Pepper settings',
};

/** A day with its year, in the business's time zone: "Nov 12, 2026". */
export function consentDayLabel(timeZone: string, instant: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(instant));
}

/** The moment, to the minute, in the business's time zone: "Thu, Nov 12, 2026, 12:00 PM". */
export function consentMomentLabel(timeZone: string, instant: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(instant));
}

/** How a consent was given, in words. */
export function consentHowLabel(source: SmsConsentSource): string {
  return `Ticked the box ${HOW[source]}`;
}

export function textsSummary(
  texts: ClientTexts,
  name: string,
  options: { timeZone: string; hasPhone: boolean },
): TextsSummary {
  const { consent } = texts;
  switch (texts.status) {
    case 'on':
      return {
        badge: { text: 'On', tone: 'ok' },
        line: consent === null ? 'Texts are on.' : onLine(consent, options.timeZone),
        next: 'I text their confirmations and reminders. They can reply STOP at any time.',
      };
    case 'opted_out':
      return {
        badge: { text: 'Off', tone: 'warn' },
        line: 'They replied STOP, so no texts go to their number.',
        next: `${name} can reply START to get texts again. Until then I email them.`,
      };
    case 'stopped':
      return {
        badge: { text: 'Off', tone: 'neutral' },
        line:
          consent?.stoppedAt === null || consent === null
            ? 'Texts are off.'
            : `Texts stopped ${consentDayLabel(options.timeZone, consent.stoppedAt)}.`,
        next: `I email ${name} instead. They can say yes again by ticking the box when they next book online.`,
      };
    case 'never':
      return {
        badge: { text: 'Not asked', tone: 'neutral' },
        line: `${name} hasn’t said yes to texts.`,
        next: !options.hasPhone
          ? 'Add their mobile number first. They can say yes when they book online.'
          : texts.textable
            ? 'They can tick the box when they book online. Until then I email them.'
            : 'Their number can’t get texts: I text US and Canadian numbers only.',
      };
  }
}

function onLine(consent: NonNullable<ClientTexts['consent']>, timeZone: string): string {
  return `Said yes ${consentDayLabel(timeZone, consent.givenAt)} ${HOW[consent.source]}.`;
}
