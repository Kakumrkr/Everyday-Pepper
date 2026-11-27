import { z } from 'zod';
import { BookingIdSchema } from './bookings.js';
import { UtcDateTimeSchema } from './time.js';
import { VisitRiskReasonSchema } from './visit-risk.js';

// Proof of value (S55, ADR-0058; AC-W4-10…13): what Pepper did for the business in the last
// 7 days, and the evening wrap of tomorrow. Both are read when Home asks, from the bookings,
// the waitlist's offers and the AI's actions: numbers, and the at-risk clients' names as the
// feed shows them. Owners and managers only: the week's dollars and those names are the
// business's.

export const PROOF_LIMITS = {
  /** The week card's window, back from now. */
  weekDays: 7,
  /** A regular is "back" when they book within this many days after a nudge reached them. */
  regularBackDays: 14,
  /** From this local hour the evening wrap of tomorrow shows. */
  eveningHour: 17,
  /** At-risk visits named on the wrap (the count covers all of them). */
  atRiskNamed: 3,
} as const;

/**
 * About how many minutes of the owner's time each thing Pepper did saves (S55, D-3): a
 * booking someone made without a call or a text back and forth; a freed time filled without
 * ringing round; an email written and sent; a move, cancel or note done in one tap. Estimates,
 * shown as "about"; one table so the card and its tests agree.
 */
export const MINUTES_SAVED = {
  /** A visit booked online or by Pepper: the call or the texts it took otherwise. */
  booking: 4,
  /** A freed time filled from the waitlist or the regulars, on top of its booking. */
  fill: 10,
  /** An email Pepper wrote and sent (a nudge, a confirmation, an offer). */
  message: 3,
  /** Any other action Pepper did (a move, a cancel, a block, a note, a rule, a to-do). */
  action: 2,
} as const;

export const WeekValueSchema = z.object({
  /** The window: `from` is 7 days before `to` (now). */
  from: UtcDateTimeSchema,
  to: UtcDateTimeSchema,
  /** Visits Pepper had a hand in: booked online or by Pepper, a fill, or a regular back. */
  visitsBooked: z.number().int().nonnegative(),
  /** Freed times filled by a claimed offer (waitlist or regular). */
  gapsFilled: z.number().int().nonnegative(),
  /** Clients who booked within 14 days after a nudge was sent to them (each once). */
  regularsBack: z.number().int().nonnegative(),
  /** What the regulars back are worth (cents): part of `valueCents`. */
  regularsBackCents: z.number().int().nonnegative(),
  /** What the visits above are worth (cents), each visit once. */
  valueCents: z.number().int().nonnegative(),
  /** About how many minutes those visits and Pepper's other actions saved (`MINUTES_SAVED`). */
  minutesSaved: z.number().int().nonnegative(),
});
export type WeekValue = z.infer<typeof WeekValueSchema>;

export const AtRiskVisitSchema = z.object({
  bookingId: BookingIdSchema,
  /** The client's name as the business keeps it. */
  clientName: z.string().max(200),
  startsAt: UtcDateTimeSchema,
  /** Why the visit is at risk: its band's top reason (S77, ADR-0071). */
  topReason: VisitRiskReasonSchema,
});
export type AtRiskVisit = z.infer<typeof AtRiskVisitSchema>;

export const EveningWrapSchema = z.object({
  /** Tomorrow, the business's local day (`YYYY-MM-DD`). */
  day: z.iso.date(),
  visitCount: z.number().int().nonnegative(),
  firstStartsAt: UtcDateTimeSchema.nullable(),
  /** Tomorrow's visits in the high risk band (S77, ADR-0071). */
  atRiskCount: z.number().int().nonnegative(),
  atRisk: z.array(AtRiskVisitSchema).max(PROOF_LIMITS.atRiskNamed),
});
export type EveningWrap = z.infer<typeof EveningWrapSchema>;

/** `GET /v1/proof`: the week card, and the evening wrap from the evening hour (else `null`). */
export const ProofResponseSchema = z.object({
  week: WeekValueSchema,
  evening: EveningWrapSchema.nullable(),
});
export type ProofResponse = z.infer<typeof ProofResponseSchema>;
