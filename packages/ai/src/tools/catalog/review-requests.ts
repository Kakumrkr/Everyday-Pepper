import {
  BookingIdSchema,
  ClientIdSchema,
  DRAFT_LIMITS,
  NudgeDraftSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
} from '@pepper/contracts';
import {
  ClientNotFoundError,
  DraftRefusedError,
  ReviewRequestNotSendableError,
  unsubscribeKeyFrom,
  unsubscribeToken,
} from '@pepper/core';
import { findBooking, findClient, findCurrentTenant, reviewTargetKey } from '@pepper/db';
import { z } from 'zod';
import { reviewEmailText } from '../../drafts/review-words.js';
import { localOf } from '../local-time.js';
import { clientFirstName } from '../names.js';
import type { Performed, WriteTool } from '../tool.js';
import { checkNoSensitiveValue } from './nudges.js';
import { directoryOf, serviceName, staffName } from './shared.js';

// The review request (S55.2, ADR-0059): one thank-you email after a kept visit, asking the
// client for a review on the business's own review page. The morning pass proposes it; it is
// never offered to the model. The domain picks the client, the visit and the words, adds the
// business's review link and the footer (name, mailing address, one-click unsubscribe), and
// checks everything again when it is approved: the visit was kept, the client can still be
// emailed, and the business still has its link and address. Its dial action is
// `message.review_request`; Undo takes the email back until it leaves.

const DraftWords = z.strictObject({
  subject: z.string().max(DRAFT_LIMITS.subjectMax),
  body: z.string().max(DRAFT_LIMITS.bodyMax),
});

const ReviewArgs = z.strictObject({
  clientId: z.uuid(),
  /** The visit the request follows. */
  bookingId: z.uuid(),
  draft: DraftWords,
});
export type ReviewArgs = z.infer<typeof ReviewArgs>;

/** The visits a review may follow: kept, not cancelled or missed. */
const KEPT = new Set(['confirmed', 'completed']);

export const sendReviewRequest: WriteTool = {
  kind: 'write',
  name: 'send_review_request',
  version: 1,
  localTimes: false,
  tier: 'external_or_irreversible',
  guide: {
    use: 'Thank a client for yesterday’s visit and ask for a review (the morning pass proposes it; never offered to the model).',
    avoid: ['for anything the member asks in the chat'],
    returns: 'the email waiting for an OK.',
    // Never offered to the model, so never read: they only satisfy the guide's shape.
    examples: [
      { say: 'Morning pass: Sara came in yesterday', args: { clientId: { $any: true } } },
      { say: 'Morning pass: Ana came in yesterday', args: { clientId: { $any: true } } },
    ],
  },
  args: ReviewArgs,
  actions: () => ['message.review_request'],
  async perform(scope, raw): Promise<Performed> {
    const args = ReviewArgs.parse(raw);
    // Checked on every run: an edit (or a stored draft) with a link or contact never goes.
    const parsed = NudgeDraftSchema.safeParse(args.draft);
    if (!parsed.success) throw new DraftRefusedError('invalid', 'The draft breaks a draft rule');
    const draft = parsed.data;
    const clientId = ClientIdSchema.parse(args.clientId);

    const tenant = await findCurrentTenant(scope.tx);
    if (tenant === undefined) throw new Error('No business in this transaction');
    if (tenant.mailingAddress === null) throw new ReviewRequestNotSendableError('no_address');
    if (tenant.reviewUrl === null) throw new ReviewRequestNotSendableError('no_review_link');
    const client = await findClient(scope.tx, clientId);
    if (client?.deletedAt !== null) throw new ClientNotFoundError();
    if (client.email === null) throw new ReviewRequestNotSendableError('no_email');
    if (client.emailOptOutAt !== null) throw new ReviewRequestNotSendableError('opted_out');
    // The visit was this client's, kept (not cancelled or missed since), and is over.
    const visit = await findBooking(scope.tx, BookingIdSchema.parse(args.bookingId));
    if (
      visit?.clientId !== clientId ||
      !KEPT.has(visit.status) ||
      visit.endsAt.getTime() > scope.now.getTime()
    ) {
      throw new ReviewRequestNotSendableError('no_visit');
    }
    await checkNoSensitiveValue(scope, clientId, draft);

    const directory = await directoryOf(scope);
    const staff = staffName(directory, StaffMemberIdSchema.parse(visit.staffMemberId));
    const service = serviceName(directory, ServiceIdSchema.parse(visit.serviceId));
    const firstName = clientFirstName(client.name) ?? 'the client';
    const { baseUrl, outboxKey } = scope.deps.emails;
    const token = unsubscribeToken(unsubscribeKeyFrom(outboxKey), {
      tenantId: scope.actor.context.tenantId,
      clientId,
    });
    await scope.emailClient({
      clientId,
      template: 'review_request',
      dedupeKey: `review.request:${clientId}:${visit.id}`,
      message: {
        to: client.email,
        subject: draft.subject,
        text: reviewEmailText({
          draft,
          reviewUrl: tenant.reviewUrl,
          businessName: tenant.name,
          mailingAddress: tenant.mailingAddress,
          unsubscribeUrl: `${baseUrl}/unsubscribe/${token}`,
        }),
        unsubscribeUrl: `${baseUrl}/v1/public/unsubscribe/${token}`,
      },
    });

    const visited = localOf(scope.timeZone, visit.startsAt);
    return {
      entity: { type: 'client', id: clientId },
      targetKey: reviewTargetKey(clientId),
      // No staff member's own record: owners and managers decide, as for every marketing email.
      recordOwner: null,
      appointmentStartsAt: null,
      before: null,
      after: {
        email: 'review',
        clientName: firstName,
        serviceName: service,
        staffName: staff,
        date: visited.date,
      },
      touched: {
        clientUpdatedAt: client.updatedAt.toISOString(),
        visitUpdatedAt: visit.updatedAt.toISOString(),
        address: tenant.mailingAddress,
        reviewUrl: tenant.reviewUrl,
      },
      // Undo is taking the email back (until it leaves); nothing else changed.
      inverse: {},
      summary: `Ask ${firstName} for a review of their ${service.toLowerCase()} with ${staff}.`,
      facts: [{ kind: 'review_visit', ref: null, value: { date: visited.date } }],
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
