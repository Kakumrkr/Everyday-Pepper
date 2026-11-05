import { z } from 'zod';

// Post-visit review requests (S55.2, ADR-0059; AC-W4-14…17): the morning after a visit, the
// morning pass drafts a short thank-you that asks the client for a review on the business's own
// review page. It waits for an owner's or manager's OK (`message.review_request`, ask by
// default) and carries the commercial-mail footer with a one-click unsubscribe. No business
// link, no request; no client is asked twice within `quietDays`.

export const REVIEW_REQUEST_LIMITS = {
  /** Review requests one business gets in one local day. */
  perBusinessPerDay: 20,
  /** No second request to a client within this many days of the last one (any outcome). */
  quietDays: 90,
  /** Visits that started within this many hours before the pass are asked about. */
  lookbackHours: 48,
  /** A web address's longest length. */
  urlMax: 500,
} as const;

/**
 * Where the business wants its reviews (its Google, Yelp or own page): an `https` address with
 * a host, no spaces and no credentials. The email links to it as it is.
 */
export const ReviewUrlSchema = z
  .string()
  .trim()
  .max(REVIEW_REQUEST_LIMITS.urlMax, 'That address is too long')
  .refine((value) => isReviewUrl(value), 'Enter the full address, starting with https://');
export type ReviewUrl = z.infer<typeof ReviewUrlSchema>;

function isReviewUrl(value: string): boolean {
  if (/\s/.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  // A public name ending in letters (g.page, yelp.com): no IP address or internal host, which
  // mail filters read as phishing.
  const tld = url.hostname.split('.').at(-1) ?? '';
  return (
    url.protocol === 'https:' &&
    url.hostname.includes('.') &&
    /^[a-z]{2,63}$/.test(tld) &&
    url.username === '' &&
    url.password === ''
  );
}
