import { z } from 'zod';
import { ServiceIdSchema, StaffMemberIdSchema, WeeklyHoursSchema } from './appointments.js';
import { TimeZoneSchema } from './tenancy.js';
import { UtcDateTimeSchema } from './time.js';

// Home's setup review (S46, PCR-009, AC-W1-11/12): what the business is set up with, for an
// owner or manager to check once, and what currently stops clients from booking. Being
// bookable is not the same as reviewed: the review stays until someone says it is checked.

/** A current reason clients can't book something, worked out from today's setup. */
export const SetupWarningSchema = z.discriminatedUnion('kind', [
  /** No active service at all. */
  z.object({ kind: z.literal('no_services') }).strict(),
  /** An active staff member who offers services but has no working hours. */
  z
    .object({
      kind: z.literal('staff_without_hours'),
      staffMemberId: StaffMemberIdSchema,
      displayName: z.string(),
    })
    .strict(),
  /** An active service that no active staff member with hours offers. */
  z
    .object({
      kind: z.literal('service_without_provider'),
      serviceId: ServiceIdSchema,
      name: z.string(),
    })
    .strict(),
]);
export type SetupWarning = z.infer<typeof SetupWarningSchema>;

/** An active staff member as the review shows them. */
export const SetupProviderSchema = z
  .object({
    id: StaffMemberIdSchema,
    displayName: z.string(),
    /** Linked to the member looking (the seeded owner sees themselves). */
    isYou: z.boolean(),
    /** How many active services they offer. */
    serviceCount: z.number().int().min(0),
    hours: WeeklyHoursSchema,
  })
  .strict();
export type SetupProvider = z.infer<typeof SetupProviderSchema>;

/** `GET /v1/setup` and `POST /v1/setup/review`: owners and managers. */
export const SetupReviewSchema = z
  .object({
    /** When someone said "I've checked these"; `null` until then. */
    reviewedAt: UtcDateTimeSchema.nullable(),
    timeZone: TimeZoneSchema,
    /** The active services: how many, and the cheapest and dearest price shown. */
    services: z
      .object({
        count: z.number().int().min(0),
        lowestPriceCents: z.number().int().nullable(),
        highestPriceCents: z.number().int().nullable(),
      })
      .strict(),
    providers: z.array(SetupProviderSchema),
    warnings: z.array(SetupWarningSchema),
    /**
     * The booking page's last 7 days (S47.2, AC-W1-14): visits that opened it and visits that
     * booked (`done` + `waitlisted`), from the step counts (ADR-0047).
     */
    week: z.object({ visits: z.number().int().min(0), booked: z.number().int().min(0) }).strict(),
  })
  .strict();
export type SetupReview = z.infer<typeof SetupReviewSchema>;
