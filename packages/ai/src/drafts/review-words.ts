import { NudgeDraftSchema, type NudgeDraft } from '@pepper/contracts';

// The words of a review request (S55.2, ADR-0059), written by the domain from what the business
// knows: the client's first name, the service and the visit's day. No model call (the request
// is the same every time, and no client's name goes to a model); an owner or manager may still
// edit them on the card. The review link and the footer are added by the send.

/**
 * A thank-you for the visit that asks for a review. A name that breaks a draft rule (too long,
 * or read as a link or contact) leaves the name and the service out rather than failing.
 */
export function reviewWords(facts: {
  firstName: string | null;
  serviceName: string;
  visitDate: string;
}): NudgeDraft {
  const service = facts.serviceName.toLowerCase();
  const ask =
    'If you have a minute, a short review would mean a lot and helps other people find us.';
  const named = NudgeDraftSchema.safeParse({
    subject:
      facts.firstName === null
        ? 'Thanks for coming in'
        : `Thanks for coming in, ${facts.firstName}`,
    body: `${facts.firstName === null ? 'Hi,' : `Hi ${facts.firstName},`}\n\nThank you for coming in for your ${service} on ${facts.visitDate}. ${ask}`,
  });
  if (named.success) return named.data;
  return NudgeDraftSchema.parse({
    subject: 'Thanks for coming in',
    body: `Hi,\n\nThank you for your visit on ${facts.visitDate}. ${ask}`,
  });
}

/** The email as the client reads it: the words, the review link, then the footer. */
export function reviewEmailText(parts: {
  draft: NudgeDraft;
  reviewUrl: string;
  businessName: string;
  mailingAddress: string;
  unsubscribeUrl: string;
}): string {
  return [
    parts.draft.body,
    '',
    'Leave a review here:',
    parts.reviewUrl,
    '',
    '--',
    parts.businessName,
    parts.mailingAddress,
    '',
    `You get this email because you are a client of ${parts.businessName}.`,
    `Unsubscribe: ${parts.unsubscribeUrl}`,
  ].join('\n');
}
