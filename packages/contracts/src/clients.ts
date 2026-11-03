import { z } from 'zod';
import { UtcDateTimeSchema } from './time.js';

// A business's clients (ADR-0017): who bookings and waitlist entries are for. S12 keeps them
// minimal (a name and how to reach them); consent, tags, notes and import come with the
// screens and messaging that use them. Clients are personal data: their fields never appear in
// the audit log or in logs.

/** A client id: a lowercased UUID. */
export const ClientIdSchema = z.uuid().toLowerCase().brand<'ClientId'>();
export type ClientId = z.infer<typeof ClientIdSchema>;

/**
 * Where a record came from: a team member in the app, the AI employee, the public booking page
 * or an import from another system.
 */
export const RecordSourceSchema = z.enum(['team', 'ai', 'booking_page', 'import']);
export type RecordSource = z.infer<typeof RecordSourceSchema>;

/** A phone number in E.164 form, e.g. `+15551234567`. */
export const PhoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/, 'Use the international form, e.g. +15551234567');

/**
 * A phone as people write it, in the international form where it can be (S47, S48): spaces,
 * dashes, dots and brackets are dropped, ten US digits get +1 and eleven starting with 1 get
 * a +. Anything else is returned without separators, for `PhoneSchema` to judge.
 */
export function normalizePhone(value: string): string {
  const digits = value.trim().replace(/[\s().-]/g, '');
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  return digits;
}

/** An email address, stored lowercased (one client per address in a business). */
export const ClientEmailSchema = z.email().max(254).toLowerCase();

/**
 * An exact email or phone to find a client by (ADR-0020): with an "@" it is an email
 * (lowercased), otherwise an E.164 phone. Staff may find any client this way, never by a part.
 */
export const ClientContactSchema = z
  .string()
  .trim()
  .max(254)
  .pipe(z.union([ClientEmailSchema, PhoneSchema]))
  .brand<'ClientContact'>();
export type ClientContact = z.infer<typeof ClientContactSchema>;

/**
 * `POST /v1/clients/lookup`: the clients with exactly this email or phone (a body, not a query
 * string, so the contact stays out of URLs and access logs).
 */
export const ClientLookupSchema = z.object({ contact: ClientContactSchema }).strict();
export type ClientLookup = z.input<typeof ClientLookupSchema>;

/** A client as a team member enters them (`POST /v1/clients`). */
export const ClientInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: ClientEmailSchema.nullable().default(null),
    phone: PhoneSchema.nullable().default(null),
  })
  .strict();
export type ClientInput = z.input<typeof ClientInputSchema>;
export type ClientFields = z.output<typeof ClientInputSchema>;

/** The most tags a client has (S49, ADR-0050). */
export const MAX_CLIENT_TAGS = 20;
/** The longest tag. */
export const MAX_CLIENT_TAG_LENGTH = 40;

/** A client's tag: trimmed, single-spaced, 1–40 characters. */
export const ClientTagSchema = z
  .string()
  .transform((tag) => tag.replace(/\s+/g, ' ').trim())
  .pipe(z.string().min(1).max(MAX_CLIENT_TAG_LENGTH));

/** Days in a month, February with 29 (a birthday may come without its year). */
export function daysInMonth(month: number, year: number | null = null): number {
  if (month === 2)
    return year === null || (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** A client's birthday (S49, ADR-0050): month and day, and the year when it's known. */
export const ClientBirthdaySchema = z
  .object({
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(31),
    year: z.number().int().min(1900).max(2100).nullable(),
  })
  .strict()
  .refine(({ month, day, year }) => day <= daysInMonth(month, year), {
    message: 'That day isn’t in the month',
  });
export type ClientBirthday = z.infer<typeof ClientBirthdaySchema>;

/** A client as the api returns them. */
export const ClientSchema = z.object({
  id: ClientIdSchema,
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  source: RecordSourceSchema,
  tags: z.array(z.string()),
  birthday: ClientBirthdaySchema.nullable(),
  createdAt: UtcDateTimeSchema,
  updatedAt: UtcDateTimeSchema,
});
export type Client = z.infer<typeof ClientSchema>;

/**
 * Query of `GET /v1/clients`: by name, at most `limit`; with `search`, only clients whose name
 * or email contains it (case-insensitive); with `import`, only the clients that import created
 * (S49, the import result's "See your clients").
 */
export const ClientsQuerySchema = z
  .object({
    search: z.string().trim().min(1).max(120).optional(),
    import: z.uuid().toLowerCase().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type ClientsQuery = z.input<typeof ClientsQuerySchema>;

export const ClientsResponseSchema = z.object({ clients: z.array(ClientSchema) });
export type ClientsResponse = z.infer<typeof ClientsResponseSchema>;
