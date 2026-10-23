import { z } from 'zod';
import { ServiceIdSchema, StaffMemberIdSchema } from './appointments.js';
import { BookingIdSchema } from './bookings.js';
import { ConversationIdSchema, ConversationTurnIdSchema } from './chat.js';
import { ClientIdSchema } from './clients.js';
import { UserIdSchema } from './tenancy.js';
import { LocalDateSchema } from './rules.js';
import { UtcDateTimeSchema } from './time.js';
import { MemoryFactIdSchema } from './memory-ids.js';
import { looksLikeContact } from './trust.js';

// What Pepper remembers (Phase 7, ADR-0034, the Phase 7 playbook): facts about the business,
// its clients, staff, services and single visits (visit notes), and short summaries of past
// conversations (episodes) embedded for semantic recall. A fact has one current value per
// subject and key; the previous value is kept only for the 7-day Undo window. Values live only
// in the memory tables: deleting a fact removes it everywhere (playbook principle 7).

export { MemoryFactIdSchema, type MemoryFactId } from './memory-ids.js';

export const MemoryEpisodeIdSchema = z.uuid().toLowerCase().brand<'MemoryEpisodeId'>();
export type MemoryEpisodeId = z.infer<typeof MemoryEpisodeIdSchema>;

export const MemorySubjectTypeSchema = z.enum([
  'business',
  'client',
  'staff',
  'service',
  'booking',
]);
export type MemorySubjectType = z.infer<typeof MemorySubjectTypeSchema>;

/** Whom or what a fact is about. A fact on a booking is a visit note ("Oct 12: 6N + 20 vol"). */
export const MemorySubjectSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('business') }).strict(),
  z.object({ type: z.literal('client'), id: ClientIdSchema }).strict(),
  z.object({ type: z.literal('staff'), id: StaffMemberIdSchema }).strict(),
  z.object({ type: z.literal('service'), id: ServiceIdSchema }).strict(),
  z.object({ type: z.literal('booking'), id: BookingIdSchema }).strict(),
]);
export type MemorySubject = z.infer<typeof MemorySubjectSchema>;

/**
 * A fact's key: a short lowercase name ("allergy", "usual_service", "formula"). Templates
 * suggest their own (Phase 7 S30); any key of this shape is accepted.
 */
export const MemoryFactKeySchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, 'A key is a short lowercase name: letters, digits and _');
export type MemoryFactKey = z.infer<typeof MemoryFactKeySchema>;

/**
 * Keys whose facts are sensitive unless said otherwise (health and personal circumstances,
 * memory.md): shown only to members who may read that client's notes.
 */
export const SENSITIVE_MEMORY_KEYS: readonly string[] = [
  'allergy',
  'health',
  'medication',
  'pregnancy',
  'injury',
  'personal',
];

export const MEMORY_LIMITS = {
  valueMax: 500,
  factsPerSubject: 50,
  factsPerBusiness: 20_000,
  episodeSummaryMax: 1_000,
  episodeClientsMax: 20,
  /** The facts an episode's conversation saved or recalled that it records (S31). */
  episodeFactsMax: 100,
  /** How long a conversation is quiet before its episode is written (playbook D-9). */
  episodeDelayMinutes: 30,
  /** How many episodes `search_memory` returns (playbook §7 S31). */
  searchMemoryResults: 5,
  episodesPerMember: 5_000,
  searchResultsMax: 10,
  /** How long a replaced value stays for Undo (the `client_note.save` window, ADR-0028). */
  previousValueDays: 7,
  /** How long an episode is kept (playbook D-9). */
  episodeRetentionDays: 365,
} as const;

/** The size of every stored embedding (`text-embedding-3-small`, playbook D-5). */
export const EMBEDDING_DIMENSIONS = 1536;

/**
 * A fact's value: what a member said, in a sentence at most. Never an email address or a phone
 * number: contacts live on the client record (playbook principle 11).
 */
export const MemoryFactValueSchema = z
  .string()
  .trim()
  .min(1)
  .max(MEMORY_LIMITS.valueMax)
  .refine((value) => !looksLikeContact(value), {
    message: 'Keep contact details on the client record, not in memory',
  });

/** Where a fact came from: a member on a screen, a member in the chat, or an AI action. */
export const MemorySourceSchema = z.enum(['screen', 'chat', 'ai_action']);
export type MemorySource = z.infer<typeof MemorySourceSchema>;

/** `active` facts are used; `proposed` ones wait for a person's OK (from untrusted text). */
export const MemoryFactStatusSchema = z.enum(['active', 'proposed']);
export type MemoryFactStatus = z.infer<typeof MemoryFactStatusSchema>;

/**
 * A fact to save. `sensitive` defaults from the key (`SENSITIVE_MEMORY_KEYS`). Saving a key
 * the subject already has replaces its value (one current value per subject and key).
 */
export const MemoryFactInputSchema = z
  .object({
    subject: MemorySubjectSchema,
    key: MemoryFactKeySchema,
    value: MemoryFactValueSchema,
    sensitive: z.boolean().optional(),
  })
  .strict();
export type MemoryFactInput = z.input<typeof MemoryFactInputSchema>;

/** Where a fact being saved came from: the chat turn, when it came from one. */
export const MemoryFactOriginSchema = z
  .object({
    source: MemorySourceSchema,
    turnId: ConversationTurnIdSchema.nullable().default(null),
    status: MemoryFactStatusSchema.default('active'),
  })
  .strict();
export type MemoryFactOrigin = z.input<typeof MemoryFactOriginSchema>;

/** A change to one fact: its value, its sensitivity, or both. */
export const MemoryFactChangeSchema = z
  .object({
    value: MemoryFactValueSchema.optional(),
    sensitive: z.boolean().optional(),
  })
  .strict()
  .refine((change) => change.value !== undefined || change.sensitive !== undefined, {
    message: 'Change the value or the sensitivity',
  });
export type MemoryFactChange = z.input<typeof MemoryFactChangeSchema>;

/** A fact as the services return it. The previous value is internal (Undo only). */
export const MemoryFactSchema = z.object({
  id: MemoryFactIdSchema,
  subject: MemorySubjectSchema,
  key: MemoryFactKeySchema,
  value: z.string(),
  sensitive: z.boolean(),
  status: MemoryFactStatusSchema,
  source: MemorySourceSchema,
  sourceTurnId: ConversationTurnIdSchema.nullable(),
  createdByUserId: UserIdSchema.nullable(),
  createdAt: UtcDateTimeSchema,
  updatedAt: UtcDateTimeSchema,
});
export type MemoryFact = z.infer<typeof MemoryFactSchema>;

/** Which facts to list: by subject type, one subject, status, and sensitivity. */
export const MemoryFactQuerySchema = z
  .object({
    subjectType: MemorySubjectTypeSchema.optional(),
    subject: MemorySubjectSchema.optional(),
    status: MemoryFactStatusSchema.default('active'),
    sensitive: z.boolean().optional(),
    limit: z.number().int().min(1).max(500).default(200),
  })
  .strict();
export type MemoryFactQuery = z.input<typeof MemoryFactQuerySchema>;

/** An embedding: `EMBEDDING_DIMENSIONS` finite numbers. */
export const EmbeddingSchema = z.array(z.number()).length(EMBEDDING_DIMENSIONS);
export type Embedding = z.infer<typeof EmbeddingSchema>;

/** An embedding model's id, as the provider names it. */
export const EmbeddingModelSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,79}$/, 'An embedding model id');

/**
 * A summary of one past conversation (written by the episode job, S31), with the clients it
 * names (so it goes with them) and its embedding. Own-only: a member recalls their own.
 */
export const MemoryEpisodeInputSchema = z
  .object({
    conversationId: ConversationIdSchema.nullable(),
    summary: z.string().trim().min(1).max(MEMORY_LIMITS.episodeSummaryMax),
    clientIds: z.array(ClientIdSchema).max(MEMORY_LIMITS.episodeClientsMax).default([]),
    /** The facts the conversation saved or recalled: forgetting one deletes the episode. */
    factIds: z.array(MemoryFactIdSchema).max(MEMORY_LIMITS.episodeFactsMax).default([]),
    /** The conversation's last turn it covers (the job's idempotency key). */
    lastTurnId: ConversationTurnIdSchema.nullable().default(null),
    embedding: EmbeddingSchema,
    embeddingModel: EmbeddingModelSchema,
  })
  .strict();
export type MemoryEpisodeInput = z.input<typeof MemoryEpisodeInputSchema>;

export const MemoryEpisodeSchema = z.object({
  id: MemoryEpisodeIdSchema,
  conversationId: ConversationIdSchema.nullable(),
  summary: z.string(),
  clientIds: z.array(ClientIdSchema),
  createdAt: UtcDateTimeSchema,
});
export type MemoryEpisode = z.infer<typeof MemoryEpisodeSchema>;

/** An episode found by similarity: `similarity` is the cosine similarity, -1 to 1. */
export const MemoryEpisodeMatchSchema = MemoryEpisodeSchema.extend({
  similarity: z.number().min(-1.0001).max(1.0001),
});
export type MemoryEpisodeMatch = z.infer<typeof MemoryEpisodeMatchSchema>;

/** The business's memory settings: whether Pepper learns new things (playbook D-15). */
export const MemorySettingsSchema = z.object({ paused: z.boolean() }).strict();
export type MemorySettings = z.infer<typeof MemorySettingsSchema>;

/**
 * A remembered fact as a screen shows it, read live by its id (S30, playbook principle 7):
 * cards, receipts and *Why?* store only the id. `gone`: deleted, or not one the viewer may
 * read (the two look the same, so a hidden fact's existence is not given away).
 */
export const MemoryFactShownSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('known'),
    factId: MemoryFactIdSchema,
    subjectType: MemorySubjectTypeSchema,
    key: MemoryFactKeySchema,
    value: z.string().max(MEMORY_LIMITS.valueMax),
    /** The value it replaced, while Undo can still bring it back; else `null`. */
    previous: z.string().max(MEMORY_LIMITS.valueMax).nullable(),
    sensitive: z.boolean(),
  }),
  z.strictObject({ state: z.literal('gone'), factId: MemoryFactIdSchema }),
]);
export type MemoryFactShown = z.infer<typeof MemoryFactShownSchema>;

/**
 * Which facts a booking warns about, by service category (template config, playbook principle
 * 10): beauty `Color` → `allergy`; wellness `Massage` → `injury`, `pregnancy`. Categories match
 * the service's own, ignoring case.
 */
export const MemoryWarningRuleSchema = z.strictObject({
  serviceCategories: z.array(z.string().trim().min(1).max(60)).min(1).max(10),
  keys: z.array(MemoryFactKeySchema).min(1).max(10),
});
export type MemoryWarningRule = z.infer<typeof MemoryWarningRuleSchema>;

/** An industry template's memory: its booking warnings and the visit-note keys it suggests. */
export const TemplateMemorySchema = z.strictObject({
  warnings: z.array(MemoryWarningRuleSchema).max(10).default([]),
  visitNoteKeys: z.array(MemoryFactKeySchema).max(10).default([]),
});
export type TemplateMemory = z.output<typeof TemplateMemorySchema>;

/**
 * The visit an AI action's explanation names as the client's last one (`last_visit`, S30):
 * its local date and the service's name. Its notes are named apart, by fact id.
 */
export const LastVisitFactValueSchema = z.strictObject({
  date: LocalDateSchema,
  serviceName: z.string().max(120),
});
export type LastVisitFactValue = z.infer<typeof LastVisitFactValueSchema>;

/** A learned rule's fact (`propose_rule`, S31): its key starts `rule_`. */
export function isLearnedRuleKey(key: string): boolean {
  return key.startsWith('rule_');
}

/**
 * A remembered fact as "What I know" and the client profile show it (S32, playbook M-5): with
 * whom it is about by name, a visit note's visit, and where it came from ("You said in chat").
 */
export const MemoryFactViewSchema = z.strictObject({
  id: MemoryFactIdSchema,
  subject: MemorySubjectSchema,
  /** The client, staff member or service; a visit note's client. `null` for the business. */
  subjectName: z.string().max(120).nullable(),
  /** A visit note's visit: when it started and the service; `null` for any other fact. */
  visit: z
    .strictObject({ startsAt: UtcDateTimeSchema, serviceName: z.string().max(120) })
    .nullable(),
  key: MemoryFactKeySchema,
  value: z.string().max(MEMORY_LIMITS.valueMax),
  sensitive: z.boolean(),
  source: MemorySourceSchema,
  /** Whether the viewer saved it (or the AI did, in the viewer's chat). */
  byYou: z.boolean(),
  createdAt: UtcDateTimeSchema,
  updatedAt: UtcDateTimeSchema,
});
export type MemoryFactView = z.infer<typeof MemoryFactViewSchema>;

/** How many facts a screen lists at once. */
export const MEMORY_FACTS_PAGE = 500;

const MemoryFactListFields = {
  subjectType: MemorySubjectTypeSchema.optional(),
  clientId: ClientIdSchema.optional(),
  bookingId: BookingIdSchema.optional(),
};
const oneClientOrVisit = (query: { clientId?: unknown; bookingId?: unknown }) =>
  query.clientId === undefined || query.bookingId === undefined;
const ONE_CLIENT_OR_VISIT = { message: 'Ask for a client or a visit, not both' };

/**
 * Which facts a screen lists (S32): active ones the member may read. `clientId`: that client's
 * facts and the notes of their visits (the client profile); `bookingId`: one visit's notes.
 */
export const MemoryFactListQuerySchema = z
  .strictObject({ ...MemoryFactListFields, sensitive: z.boolean().optional() })
  .refine(oneClientOrVisit, ONE_CLIENT_OR_VISIT);
export type MemoryFactListQuery = z.input<typeof MemoryFactListQuerySchema>;

/** `GET /v1/memory/facts`: `MemoryFactListQuerySchema` from a query string. */
export const MemoryFactsHttpQuerySchema = z
  .strictObject({
    ...MemoryFactListFields,
    sensitive: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
  })
  .refine(oneClientOrVisit, ONE_CLIENT_OR_VISIT);

export const MemoryFactsResponseSchema = z.strictObject({
  facts: z.array(MemoryFactViewSchema).max(MEMORY_FACTS_PAGE),
});
export type MemoryFactsResponse = z.infer<typeof MemoryFactsResponseSchema>;

/** `POST /v1/memory/facts/shown`: the live state of facts an answer used (the chip, S32). */
export const MemoryFactsShownRequestSchema = z.strictObject({
  factIds: z.array(MemoryFactIdSchema).min(1).max(MEMORY_LIMITS.episodeFactsMax),
});
export type MemoryFactsShownRequest = z.infer<typeof MemoryFactsShownRequestSchema>;

export const MemoryFactsShownResponseSchema = z.strictObject({
  facts: z.array(MemoryFactShownSchema).max(MEMORY_LIMITS.episodeFactsMax),
});
export type MemoryFactsShownResponse = z.infer<typeof MemoryFactsShownResponseSchema>;

export const MemoryEpisodesResponseSchema = z.strictObject({
  episodes: z.array(MemoryEpisodeSchema.strict()),
});
export type MemoryEpisodesResponse = z.infer<typeof MemoryEpisodesResponseSchema>;
