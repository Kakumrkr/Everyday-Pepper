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

/** A client's tags as a team member enters them: no repeats (ignoring case), at most 20. */
export const ClientTagsSchema = z
  .array(ClientTagSchema)
  .max(MAX_CLIENT_TAGS)
  .transform((tags) => {
    const seen = new Set<string>();
    return tags.filter((tag) => {
      const key = tag.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

/**
 * A client as a team member enters them (`POST /v1/clients`, `PUT /v1/clients/:id`). Tags and
 * birthday (S50) are optional: left out, an edit keeps them as they are.
 */
export const ClientInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: ClientEmailSchema.nullable().default(null),
    phone: PhoneSchema.nullable().default(null),
    tags: ClientTagsSchema.optional(),
    birthday: ClientBirthdaySchema.nullable().optional(),
  })
  .strict();
export type ClientInput = z.input<typeof ClientInputSchema>;
export type ClientFields = z.output<typeof ClientInputSchema>;

/**
 * A walk-in client as staff add them with their booking (`POST /v1/bookings/walk-in`, S50.2,
 * ADR-0052): a name, and an email or phone when the client gives one.
 */
export const WalkInClientSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: ClientEmailSchema.nullable().default(null),
    phone: PhoneSchema.nullable().default(null),
  })
  .strict();
export type WalkInClientInput = z.input<typeof WalkInClientSchema>;
export type WalkInClient = z.output<typeof WalkInClientSchema>;

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
 * or email contains it (case-insensitive) or whose phone contains its digits (at least 3, any
 * format; S50.2); with `import`, only the clients that import created (S49, the import result's
 * "See your clients"); with `after`, the page after that client (the `nextCursor` of the page
 * before, S50.2: a client id, so no name, email or phone is ever in the address).
 */
export const ClientsQuerySchema = z
  .object({
    search: z.string().trim().min(1).max(120).optional(),
    import: z.uuid().toLowerCase().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    after: ClientIdSchema.optional(),
  })
  .strict();
export type ClientsQuery = z.input<typeof ClientsQuerySchema>;

export const ClientsResponseSchema = z.object({ clients: z.array(ClientSchema) });
export type ClientsResponse = z.infer<typeof ClientsResponseSchema>;

/** `GET /v1/clients`: a page, and the cursor of the next one (`null` after the last). */
export const ClientsPageSchema = ClientsResponseSchema.extend({
  nextCursor: ClientIdSchema.nullable(),
});
export type ClientsPage = z.infer<typeof ClientsPageSchema>;

/** The most client names one `GET /v1/clients/names` answers (an address stays short). */
export const MAX_CLIENT_NAMES = 100;

/**
 * Query of `GET /v1/clients/names` (S50.2): the names on visits (the calendar, the booking
 * sheet) in one request: `ids`, comma-separated client ids (never a name or contact).
 */
/** The clients one names request asks about (1 to `MAX_CLIENT_NAMES`). */
export const ClientNameIdsSchema = z.array(ClientIdSchema).min(1).max(MAX_CLIENT_NAMES);

export const ClientNamesRequestSchema = z
  .object({
    ids: z
      .string()
      .transform((text) => text.split(','))
      .pipe(ClientNameIdsSchema),
  })
  .strict();
export type ClientNamesRequest = z.input<typeof ClientNamesRequestSchema>;

/**
 * The names of the clients asked for that the member may see; a deleted client (ADR-0051) as
 * "Deleted client" with `deleted`, so no link leads to their profile.
 */
export const ClientNamesResponseSchema = z.object({
  names: z.array(z.object({ id: ClientIdSchema, name: z.string(), deleted: z.boolean() })),
});
export type ClientNamesResponse = z.infer<typeof ClientNamesResponseSchema>;

/**
 * `POST /v1/clients/:clientId/merge` (S50, ADR-0051): `otherClientId` goes into the client of
 * the path, who is kept. Owners and managers only.
 */
export const ClientMergeSchema = z.object({ otherClientId: ClientIdSchema }).strict();
export type ClientMerge = z.input<typeof ClientMergeSchema>;

/**
 * `GET /v1/clients/:clientId/records` (S50): what a merge would move or a deletion would keep
 * and forget, as counts. Visits are bookings not cancelled; upcoming ones end after now.
 */
export const ClientRecordsSchema = z.object({
  upcomingVisits: z.number().int().min(0),
  pastVisits: z.number().int().min(0),
  waitlistEntries: z.number().int().min(0),
  notes: z.number().int().min(0),
});
export type ClientRecords = z.infer<typeof ClientRecordsSchema>;
