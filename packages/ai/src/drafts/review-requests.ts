import { listServicesIn } from '@pepper/appointments';
import {
  ClientIdSchema,
  REVIEW_REQUEST_LIMITS,
  type LocalDate,
  type TenantId,
  type TrustJson,
} from '@pepper/contracts';
import { proposeForBusiness, type Actor, type Clock } from '@pepper/core';
import { findClient, listReviewCandidates, withTenant, type Database } from '@pepper/db';
import { sendReviewRequest } from '../tools/catalog/review-requests.js';
import { toolRefusalOf } from '../tools/errors.js';
import { clientFirstName } from '../tools/names.js';
import { writeRunner } from '../tools/runner.js';
import type { ToolDeps } from '../tools/tool.js';
import { reviewWords } from './review-words.js';
import { visitDateWords } from './visit-date.js';

// Post-visit review requests (S55.2, ADR-0059; AC-W4-14…16): part of the morning pass. For each
// client whose visit in the last `lookbackHours` was kept, it proposes one thank-you that asks
// for a review, with words the domain writes (no model call) and the business's review link.
// Each waits for an owner's or manager's OK (`message.review_request`, ask by default); no
// client is asked twice within `quietDays`, and a business gets at most `perBusinessPerDay` a
// day. The caller checks that the business has its mailing address and its review link.

const HOUR_MS = 3_600_000;

export interface ReviewRequestsResult {
  drafted: number;
  /** The domain refused one (the client opted out, the visit was cancelled meanwhile). */
  refused: number;
  /** Something broke unexpectedly (the next morning tries again). */
  failed: number;
}

/** Proposes this morning's review requests for one business, as its AI acting for the owner. */
export async function draftReviewRequestsFor(
  db: Database,
  tenantId: TenantId,
  context: {
    ai: Actor;
    deps: ToolDeps;
    timeZone: string;
    today: LocalDate;
    clock: Clock;
    /** Tests lower the daily cap; the app uses `REVIEW_REQUEST_LIMITS.perBusinessPerDay`. */
    perBusinessPerDay?: number;
  },
): Promise<ReviewRequestsResult> {
  const now = context.clock.now();
  const result: ReviewRequestsResult = { drafted: 0, refused: 0, failed: 0 };
  const candidates = await withTenant(db, tenantId, async (tx) => {
    const visits = await listReviewCandidates(tx, {
      now,
      since: new Date(now.getTime() - REVIEW_REQUEST_LIMITS.lookbackHours * HOUR_MS),
      quietDays: REVIEW_REQUEST_LIMITS.quietDays,
      limit: context.perBusinessPerDay ?? REVIEW_REQUEST_LIMITS.perBusinessPerDay,
    });
    if (visits.length === 0) return [];
    const services = await listServicesIn(tx, context.ai);
    const named = [];
    for (const visit of visits) {
      const client = await findClient(tx, ClientIdSchema.parse(visit.clientId));
      if (client === undefined) continue;
      named.push({
        visit,
        firstName: clientFirstName(client.name) ?? null,
        serviceName: services.find((each) => each.id === visit.serviceId)?.name ?? 'visit',
      });
    }
    return named;
  });

  for (const { visit, firstName, serviceName } of candidates) {
    const payload: TrustJson = {
      clientId: visit.clientId,
      bookingId: visit.bookingId,
      draft: reviewWords({
        firstName,
        serviceName,
        visitDate: visitDateWords(context.timeZone, visit.startsAt, now),
      }),
    };
    try {
      await withTenant(db, tenantId, (tx) =>
        proposeForBusiness(
          tx,
          context.ai,
          writeRunner(sendReviewRequest, context.deps, payload).runner,
          {
            payload,
            idempotencyKey: `review.${visit.clientId}.${context.today}`,
            explanation: {
              requestMessageId: null,
              steps: [{ tool: 'review_requests', input: {} }],
              facts: [],
              alternatives: [],
            },
            // The client's own name is in the words, and it came from outside the team.
            untrustedContext: true,
          },
          { clock: context.clock },
        ),
      );
      result.drafted += 1;
    } catch (error) {
      // A bug or the database is reported as such, not counted as the domain's refusal.
      result[toolRefusalOf(error).code === 'internal' ? 'failed' : 'refused'] += 1;
    }
  }
  return result;
}
