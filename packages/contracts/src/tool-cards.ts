import { z } from 'zod';
import { BookingIdSchema, BookingStatusSchema } from './bookings.js';
import { ClientIdSchema } from './clients.js';
import { ServiceIdSchema, StaffMemberIdSchema } from './appointments.js';
import { LocalDateSchema } from './rules.js';
import {
  ActionExecutionIdSchema,
  ActionProposalIdSchema,
  AutonomyActionSchema,
  StateFingerprintSchema,
} from './trust.js';
import { UtcDateTimeSchema } from './time.js';

// What the AI's tools give back besides their answer to the model (ADR-0029): stable error
// codes the model can act on, and typed cards the chat (S26) and the feed render. Cards carry
// ids, the business's local dates and times, and the names a member sees on the screens; never
// a client's email address or phone number.

/**
 * Why a tool call did not do what was asked, as a stable code the model can act on:
 * - `invalid_arguments`: the call did not fit the tool's schema (fix the arguments);
 * - `unknown_tool`: no such tool;
 * - `not_found`: no such record in this business, or not one the member may reach;
 * - `forbidden`: the member's role may not do this (say so; never retry another way);
 * - `slot_unavailable`: the time can't be booked; the 3 nearest times that can come with it;
 * - `not_changeable`: the record's state doesn't allow it (a cancelled booking);
 * - `too_late`: the appointment has already started;
 * - `conflict`: the same request was already made differently;
 * - `internal`: something failed on our side; nothing changed.
 */
export const ToolErrorCodeSchema = z.enum([
  'invalid_arguments',
  'unknown_tool',
  'not_found',
  'forbidden',
  'slot_unavailable',
  'not_changeable',
  'too_late',
  'conflict',
  'internal',
]);
export type ToolErrorCode = z.infer<typeof ToolErrorCodeSchema>;

/** A wall-clock time in the business's time zone, 24-hour `HH:MM`. */
export const LocalTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM in the business time zone, e.g. 14:30');
export type LocalTime = z.infer<typeof LocalTimeSchema>;

/** A start time with one staff member, in the business's time zone. */
export const LocalSlotSchema = z.strictObject({
  date: LocalDateSchema,
  time: LocalTimeSchema,
  staffMemberId: StaffMemberIdSchema,
  staffName: z.string().max(80),
});
export type LocalSlot = z.infer<typeof LocalSlotSchema>;

/** A booking as a card shows it. */
export const BookingViewSchema = z.strictObject({
  bookingId: BookingIdSchema,
  date: LocalDateSchema,
  time: LocalTimeSchema,
  endTime: LocalTimeSchema,
  clientId: ClientIdSchema,
  /** First name and last initial only (ADR-0029). */
  clientName: z.string().max(40),
  serviceId: ServiceIdSchema,
  serviceName: z.string().max(80),
  staffMemberId: StaffMemberIdSchema,
  staffName: z.string().max(80),
  status: BookingStatusSchema,
});
export type BookingView = z.infer<typeof BookingViewSchema>;

/** One side of a change: ids, local dates and times, codes. */
export const ChangeSideSchema = z.record(
  z.string().max(40),
  z.union([z.string().max(200), z.number(), z.boolean(), z.null()]),
);
export type ChangeSide = z.infer<typeof ChangeSideSchema>;

/** An email the change sends (or would send) a client: which template, to whom (by id). */
export const WouldBeEmailSchema = z.strictObject({
  template: z.enum(['confirmed', 'rescheduled', 'cancelled']),
  clientId: ClientIdSchema,
});
export type WouldBeEmail = z.infer<typeof WouldBeEmailSchema>;

export const ToolCardSchema = z.discriminatedUnion('kind', [
  /** Times to pick from: the nearest instead of a refused one, or the free ones asked for. */
  z.strictObject({
    kind: z.literal('slot_picker'),
    reason: z.enum(['alternatives', 'availability']),
    /** The service the times are for; `null` when moving a booking (it keeps its own). */
    serviceId: ServiceIdSchema.nullable(),
    slots: z.array(LocalSlotSchema).max(20),
  }),
  /** More than one client matches: the member picks (never the model's guess). */
  z.strictObject({
    kind: z.literal('client_choice'),
    clients: z
      .array(z.strictObject({ clientId: ClientIdSchema, name: z.string().max(40) }))
      .max(10),
  }),
  /** A write: exactly what changes and which emails go, waiting for OK or done with Undo. */
  z.strictObject({
    kind: z.literal('change'),
    tool: z.string().max(64),
    action: AutonomyActionSchema,
    state: z.enum(['proposed', 'done']),
    proposalId: ActionProposalIdSchema.nullable(),
    /** The fingerprint the member approves with (a proposal only). */
    fingerprint: StateFingerprintSchema.nullable(),
    executionId: ActionExecutionIdSchema.nullable(),
    undoUntil: UtcDateTimeSchema.nullable(),
    before: ChangeSideSchema.nullable(),
    after: ChangeSideSchema.nullable(),
    emails: z.array(WouldBeEmailSchema).max(20),
  }),
  z.strictObject({ kind: z.literal('booking'), booking: BookingViewSchema }),
  /** One day's schedule. */
  z.strictObject({
    kind: z.literal('day'),
    date: LocalDateSchema,
    bookings: z.array(BookingViewSchema).max(100),
    blocked: z
      .array(
        z.strictObject({
          staffMemberId: StaffMemberIdSchema,
          staffName: z.string().max(80),
          from: LocalTimeSchema,
          to: LocalTimeSchema,
        }),
      )
      .max(100),
  }),
]);
export type ToolCard = z.infer<typeof ToolCardSchema>;
