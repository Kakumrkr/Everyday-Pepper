import { z } from 'zod';
import { BookingIdSchema } from './bookings.js';
import { TimeZoneSchema } from './tenancy.js';
import { UtcDateTimeSchema } from './time.js';

// Reading a client's kept text (S81a, ADR-0073): one forced call on the routine route says what
// the text asks; the domain decides what, if anything, happens. These are the question the
// reader is given and the reading it returns, both checked here.

export const CLIENT_TEXT_READ_LIMITS = {
  /** The client's next visits the model is shown, at most. */
  visits: 5,
  /** The tokens one reading may use, and its answer at most. */
  maxTokens: 1_500,
  maxOutputTokens: 200,
  /** "Running late" past this many minutes is not a reading the domain acts on. */
  maxMinutesLate: 180,
} as const;

/** What a client's text asks (AC-X-238). */
export const CLIENT_TEXT_INTENTS = [
  'confirm',
  'cancel',
  'reschedule',
  'running_late',
  'question',
  'other',
] as const;
export const ClientTextIntentSchema = z.enum(CLIENT_TEXT_INTENTS);
export type ClientTextIntent = z.infer<typeof ClientTextIntentSchema>;

/** A local date and time of day, as the business's clock shows them. */
const LocalDateSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
const LocalTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** The reader's question: the text and the client's next visits, ids and times only (AC-X-237). */
export const ClientTextQuestionSchema = z
  .object({
    text: z.string().trim().min(1).max(1600),
    now: UtcDateTimeSchema,
    timeZone: TimeZoneSchema,
    visits: z
      .array(z.object({ id: BookingIdSchema, startsAt: UtcDateTimeSchema }).strict())
      .max(CLIENT_TEXT_READ_LIMITS.visits),
  })
  .strict();
export type ClientTextQuestion = z.infer<typeof ClientTextQuestionSchema>;

/**
 * What the text asks (AC-X-238): the visit it is about (null: none, or more than one fits), the
 * local date and/or time a reschedule asks for, the minutes a client running late gives, and
 * whether the model is sure. A field only belongs to its intent.
 */
export const ClientTextReadingSchema = z
  .object({
    intent: ClientTextIntentSchema,
    visitId: BookingIdSchema.nullable(),
    askedFor: z
      .object({ date: LocalDateSchema.nullable(), time: LocalTimeSchema.nullable() })
      .strict()
      .refine((asked) => asked.date !== null || asked.time !== null, 'A date or a time')
      .nullable(),
    minutesLate: z.int().min(1).max(CLIENT_TEXT_READ_LIMITS.maxMinutesLate).nullable(),
    confidence: z.enum(['sure', 'unsure']),
  })
  .strict()
  .refine((reading) => reading.askedFor === null || reading.intent === 'reschedule', {
    message: 'A time asked for only with reschedule',
  })
  .refine((reading) => reading.minutesLate === null || reading.intent === 'running_late', {
    message: 'Minutes late only with running_late',
  });
export type ClientTextReading = z.infer<typeof ClientTextReadingSchema>;
