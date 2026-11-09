import { findAvailabilityIn } from '@pepper/appointments';
import {
  aiDisclosureLines,
  ClientIdSchema,
  DRAFT_LIMITS,
  NudgeDraftSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  UtcDateTimeSchema,
  type ClientId,
  type NudgeDraft,
} from '@pepper/contracts';
import {
  ClientNotFoundError,
  DraftRefusedError,
  NudgeNotSendableError,
  unsubscribeKeyFrom,
  unsubscribeToken,
} from '@pepper/core';
import { activeMemoryFactsOf, findClient, findCurrentTenant, nudgeTargetKey } from '@pepper/db';
import { SlotUnavailableError } from '@pepper/appointments';
import { z } from 'zod';
import { localOf } from '../local-time.js';
import { clientFirstName } from '../names.js';
import type { Performed, ToolScope, WriteTool } from '../tool.js';
import { directoryOf, domainOptions, serviceName, staffName, when } from './shared.js';

// The rebooking nudge (S36, ADR-0040, playbook D-3 and D-9): one email to one regular who is due
// back, offering an open time the domain found. The morning pass proposes it; it is never
// offered to the model, which writes only the words. Everything else is the domain's: the
// client and their address, the time (still free when approved), the booking link, and the
// footer with the business's name, mailing address and a one-click unsubscribe link. Its dial
// action is `message.rebooking_nudge`; Undo takes the email back until it leaves.
// Words the model wrote say so above the footer, with a link to the privacy policy's AI section
// (S59.5, ADR-0064, AC-X-55); win-back's words are Pepper's fixed ones and don't.

/** Who wrote a nudge's words: the model, or Pepper's fixed words. */
export const NudgeWordsBySchema = z.enum(['ai', 'template']);
export type NudgeWordsBy = z.infer<typeof NudgeWordsBySchema>;

/** The words as stored with the proposal (checked again on every run). */
const DraftWords = z.strictObject({
  subject: z.string().max(DRAFT_LIMITS.subjectMax),
  body: z.string().max(DRAFT_LIMITS.bodyMax),
});

const NudgeArgs = z.strictObject({
  clientId: z.uuid(),
  serviceId: z.uuid(),
  staffMemberId: z.uuid(),
  /** The open time offered (UTC), found by the morning pass. */
  startsAt: UtcDateTimeSchema,
  /** The client's last visit (UTC), for *Why?*. */
  lastVisitAt: UtcDateTimeSchema,
  draft: DraftWords,
  /**
   * Who wrote the words (S59.5): the model (the morning pass) or Pepper's fixed words (a
   * win-back tap). Set by the domain, never a model (the tool is never offered to one). A nudge
   * proposed before S59.5 has none and counts as the model's: a missing line would mislead,
   * an extra one can't.
   */
  wordsBy: NudgeWordsBySchema.optional(),
});
export type NudgeArgs = z.infer<typeof NudgeArgs>;

/** The email's own words, the open time and link, and the footer, as the client reads them. */
export function nudgeEmailText(parts: {
  draft: NudgeDraft;
  staffName: string;
  when: string;
  bookingUrl: string;
  businessName: string;
  mailingAddress: string;
  unsubscribeUrl: string;
  /** The AI disclosure's lines (`aiDisclosureLines`), or none for Pepper's fixed words. */
  disclosure: readonly string[];
}): string {
  return [
    parts.draft.body,
    '',
    `${parts.staffName} has an opening ${parts.when}. Book it here:`,
    parts.bookingUrl,
    '',
    ...(parts.disclosure.length === 0 ? [] : [...parts.disclosure, '']),
    '--',
    parts.businessName,
    parts.mailingAddress,
    '',
    `You get this email because you are a client of ${parts.businessName}.`,
    `Unsubscribe: ${parts.unsubscribeUrl}`,
  ].join('\n');
}

/**
 * The disclosure a nudge carries (AC-X-55): none for Pepper's fixed words; the model's words,
 * and a nudge stored before S59.5 without `wordsBy`, say so.
 */
export function nudgeDisclosure(
  wordsBy: NudgeWordsBy | undefined,
  businessName: string,
  baseUrl: string,
): string[] {
  return wordsBy === 'template' ? [] : aiDisclosureLines(businessName, baseUrl);
}

/** "on Tuesday, October 27 at 2:00 PM", in the business's time zone. */
export function friendlyWhen(timeZone: string, instant: string): string {
  const at = new Date(instant);
  const date = at.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone,
  });
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone });
  return `on ${date} at ${time}`;
}

/**
 * The client's (and the business's) sensitive remembered values a draft must not hold (playbook
 * §6, LLM02): an allergy, a health note. The model is never given them; this holds whatever
 * it, or a member's edit, writes.
 */
export async function checkNoSensitiveValue(
  scope: ToolScope,
  clientId: ClientId,
  draft: NudgeDraft,
): Promise<void> {
  const facts = await activeMemoryFactsOf(
    scope.tx,
    [{ type: 'client', id: clientId }, { type: 'business' }],
    200,
  );
  const words = `${draft.subject}\n${draft.body}`.toLowerCase();
  const leaked = facts.some(
    (fact) =>
      fact.sensitive &&
      fact.value.trim().length >= 3 &&
      words.includes(fact.value.trim().toLowerCase()),
  );
  if (leaked) throw new DraftRefusedError('sensitive', 'The draft names something sensitive');
}

export const sendRebookingNudge: WriteTool = {
  kind: 'write',
  name: 'send_rebooking_nudge',
  version: 1,
  localTimes: false,
  tier: 'external_or_irreversible',
  guide: {
    use: 'Email a regular who is due back about an open time (the morning pass proposes it; never offered to the model).',
    avoid: ['for anything the member asks in the chat'],
    returns: 'the email waiting for an OK.',
    // Never offered to the model, so never read: they only satisfy the guide's shape.
    examples: [
      {
        say: 'Morning pass: Sara is due back and Jess is free tomorrow',
        args: { clientId: { $any: true } },
      },
      {
        say: 'Morning pass: Ana is due back and Marco is free tomorrow',
        args: { clientId: { $any: true } },
      },
    ],
  },
  args: NudgeArgs,
  actions: () => ['message.rebooking_nudge'],
  async perform(scope, raw): Promise<Performed> {
    const args = NudgeArgs.parse(raw);
    // Checked on every run: an edit (or a stored draft) with a link or contact never goes.
    const parsed = NudgeDraftSchema.safeParse(args.draft);
    if (!parsed.success) throw new DraftRefusedError('invalid', 'The draft breaks a draft rule');
    const draft = parsed.data;
    const clientId = ClientIdSchema.parse(args.clientId);
    const serviceId = ServiceIdSchema.parse(args.serviceId);
    const staffMemberId = StaffMemberIdSchema.parse(args.staffMemberId);

    const tenant = await findCurrentTenant(scope.tx);
    if (tenant === undefined) throw new Error('No business in this transaction');
    if (tenant.mailingAddress === null) throw new NudgeNotSendableError('no_address');
    const client = await findClient(scope.tx, clientId);
    if (client === undefined) throw new ClientNotFoundError();
    if (client.email === null) throw new NudgeNotSendableError('no_email');
    if (client.emailOptOutAt !== null) throw new NudgeNotSendableError('opted_out');
    await checkNoSensitiveValue(scope, clientId, draft);

    // The time is still free now (and again at approval: the fingerprint holds it).
    const start = Date.parse(args.startsAt);
    if (start <= scope.now.getTime()) throw new SlotUnavailableError([]);
    const slots = await findAvailabilityIn(
      scope.tx,
      scope.actor,
      {
        serviceId,
        staffMemberId,
        from: args.startsAt,
        to: new Date(start + 60_000).toISOString(),
      },
      domainOptions(scope),
    );
    if (!slots.some((slot) => Date.parse(slot.startsAt) === start)) {
      throw new SlotUnavailableError([]);
    }

    const directory = await directoryOf(scope);
    const staff = staffName(directory, staffMemberId);
    const service = serviceName(directory, serviceId);
    const firstName = clientFirstName(client.name) ?? 'the client';
    const { baseUrl, outboxKey } = scope.deps.emails;
    const token = unsubscribeToken(unsubscribeKeyFrom(outboxKey), {
      tenantId: scope.actor.context.tenantId,
      clientId,
    });
    await scope.emailClient({
      clientId,
      template: 'rebooking_nudge',
      dedupeKey: `nudge.rebooking:${clientId}:${String(start)}`,
      message: {
        to: client.email,
        subject: draft.subject,
        text: nudgeEmailText({
          draft,
          staffName: staff,
          when: friendlyWhen(scope.timeZone, args.startsAt),
          bookingUrl: `${baseUrl}/book/${encodeURIComponent(tenant.slug)}`,
          businessName: tenant.name,
          mailingAddress: tenant.mailingAddress,
          unsubscribeUrl: `${baseUrl}/unsubscribe/${token}`,
          disclosure: nudgeDisclosure(args.wordsBy, tenant.name, baseUrl),
        }),
        unsubscribeUrl: `${baseUrl}/v1/public/unsubscribe/${token}`,
      },
    });

    const offered = localOf(scope.timeZone, args.startsAt);
    const last = localOf(scope.timeZone, args.lastVisitAt);
    return {
      entity: { type: 'client', id: clientId },
      targetKey: nudgeTargetKey(clientId),
      // No staff member's own record: owners and managers decide (S36 D-3).
      recordOwner: null,
      appointmentStartsAt: new Date(start),
      before: null,
      after: {
        email: 'rebooking',
        clientName: firstName,
        serviceName: service,
        staffName: staff,
        date: offered.date,
        time: offered.time,
      },
      touched: {
        clientUpdatedAt: client.updatedAt.toISOString(),
        address: tenant.mailingAddress,
        slot: args.startsAt,
      },
      // Undo is taking the email back (until it leaves); nothing else changed.
      inverse: {},
      summary: `Email ${firstName} about a ${service.toLowerCase()}: ${staff} is free ${when(offered.date, offered.time)}.`,
      facts: [
        { kind: 'nudge_last_visit', ref: null, value: { date: last.date } },
        {
          kind: 'slot_was_free',
          ref: null,
          value: { date: offered.date, time: offered.time, staffName: staff },
        },
      ],
      // A client's own name came from outside the team (the booking page).
      untrustedText: true,
      draft,
    };
  },
  undo(): Promise<void> {
    // The trust layer takes the email back; there is nothing else to reverse.
    return Promise.resolve();
  },
};
