import {
  SlotUnavailableError,
  stillOfferable,
  waitlistCandidatesIn,
  type TemplateRuleDefaultsOf,
} from '@pepper/appointments';
import {
  TemplateIdSchema,
  UserIdSchema,
  WaitlistMatchIdSchema,
  type AutonomySettings,
  type TemplateId,
  type TemplateWaitlist,
  type TenantId,
  type TrustJson,
} from '@pepper/contracts';
import { actForBusiness, type Actor, type Clock } from '@pepper/core';
import {
  claimWaitlistMatch,
  expireWaitlistOffers,
  findCurrentTenant,
  finishWaitlistMatch,
  listMemberships,
  retryWaitlistMatch,
  WAITLIST_MATCH_MAX_ATTEMPTS,
  withTenant,
  type Database,
  type DueWaitlistMatch,
  type TenantTx,
  type WaitlistMatchRow,
  type WaitlistMatchOutcome,
} from '@pepper/db';
import { sendWaitlistOffers } from '../tools/catalog/waitlist.js';
import { writeRunner } from '../tools/runner.js';
import type { ToolDeps } from '../tools/tool.js';

// The smart waitlist's matcher (S37, ADR-0041, AC-W5-1): the worker's BullMQ job for one freed
// time. Inside the business it claims the match row for a lease (committed, so another worker
// skips it), closes offers past their time, ranks who is waiting (the published formula) and
// hands the best few to the trust layer as one `send_waitlist_offers` action of the business:
// the dial for `message.waitlist_offer` decides whether it waits under "Needs your OK" (ask,
// the default) or goes now. No model is called. A failure is retried with a back-off, at most
// five attempts; the match row records the outcome.

/** How long a claimed match is hidden from other workers. */
export const MATCH_LEASE_MS = 60_000;
/** Back-off before the next attempt after the `n`th failure: 10 s, 20 s, 40 s, 80 s. */
export const matchRetryDelayMs = (attempts: number) => 10_000 * 2 ** Math.max(0, attempts - 1);

export interface MatcherOptions {
  clock: Clock;
  /** The industry template's settings (the worker passes them; L2 never imports L3). */
  waitlistOf: (templateId: TemplateId | null) => TemplateWaitlist;
  autonomyOf: (templateId: TemplateId | null) => AutonomySettings;
  templateRuleDefaults?: TemplateRuleDefaultsOf;
  /** For the offer emails (claim links, sealed in the outbox). */
  emails: { baseUrl: string; outboxKey: Buffer };
}

export type MatchResult = WaitlistMatchOutcome | 'skipped' | 'retry';

/** Runs the match a job names, at most once per lease; returns what it did. */
export async function runWaitlistMatch(
  db: Database,
  due: DueWaitlistMatch,
  options: MatcherOptions,
): Promise<MatchResult> {
  const matchId = WaitlistMatchIdSchema.parse(due.matchId);
  const now = options.clock.now();
  const claimed = await withTenant(db, due.tenantId, (tx) =>
    claimWaitlistMatch(tx, matchId, now, new Date(now.getTime() + MATCH_LEASE_MS)),
  );
  if (claimed === undefined) return 'skipped';
  try {
    return await withTenant(db, due.tenantId, async (tx) => {
      const outcome = await matchIn(db, tx, due.tenantId, claimed, options);
      await finishWaitlistMatch(tx, matchId, outcome);
      return outcome;
    });
  } catch (error) {
    const giveUp = claimed.attempts >= WAITLIST_MATCH_MAX_ATTEMPTS;
    await withTenant(db, due.tenantId, (tx) =>
      giveUp
        ? finishWaitlistMatch(tx, matchId, 'failed')
        : retryWaitlistMatch(
            tx,
            matchId,
            new Date(options.clock.now().getTime() + matchRetryDelayMs(claimed.attempts)),
          ),
    );
    if (giveUp) throw error;
    return 'retry';
  }
}

async function matchIn(
  db: Database,
  tx: TenantTx,
  tenantId: TenantId,
  match: WaitlistMatchRow,
  options: MatcherOptions,
): Promise<WaitlistMatchOutcome> {
  const now = options.clock.now();
  // Offers past their time put their entries back on the list first.
  await expireWaitlistOffers(tx, now, 500);
  if (!stillOfferable(match.startsAt, now)) return 'too_soon';
  const tenant = await findCurrentTenant(tx);
  if (tenant === undefined) throw new Error('No business in this transaction');
  const templateId = tenant.templateId === null ? null : TemplateIdSchema.parse(tenant.templateId);
  const owner = (await listMemberships(tx)).find((member) => member.role === 'owner');
  if (owner === undefined) return 'no_match';

  const ranked = await waitlistCandidatesIn(tx, match, {
    now,
    fanOut: options.waitlistOf(templateId).offerFanOut,
    templateRuleDefaults: options.templateRuleDefaults,
  });
  if (ranked.length === 0) return 'no_match';

  // The business's AI, acting for its owner: the domain's checks pass, and a proposal waits
  // for an owner or manager (as the morning pass, ADR-0040).
  const ai: Actor = {
    context: { tenantId, userId: UserIdSchema.parse(owner.userId), role: 'owner' },
    requestId: `waitlist-${match.id}`,
    via: 'ai',
  };
  const deps: ToolDeps = {
    db,
    actor: ai,
    clock: options.clock,
    ...(options.templateRuleDefaults !== undefined && {
      templateRuleDefaults: options.templateRuleDefaults,
    }),
    autonomy: { templateDefaults: options.autonomyOf(templateId) },
    emails: options.emails,
  };
  const payload: TrustJson = {
    matchId: match.id,
    staffMemberId: match.staffMemberId,
    startsAt: match.startsAt.toISOString(),
    entries: ranked.map((r) => ({
      entryId: r.entryId,
      rank: r.rank,
      fit: r.fit,
      waitingSince: r.waitingSince,
      visits: r.visits,
    })),
  };
  try {
    const result = await actForBusiness(
      tx,
      ai,
      writeRunner(sendWaitlistOffers, deps, payload).runner,
      {
        payload,
        idempotencyKey: `waitlist.${match.id}`,
        explanation: {
          requestMessageId: null,
          steps: [{ tool: 'rank_waitlist', input: {} }],
          facts: [],
          alternatives: [],
        },
        // No model read anything: the ranking and the words are the domain's.
        untrustedContext: false,
      },
      { clock: options.clock, templateDefaults: options.autonomyOf(templateId) },
    );
    return result.kind === 'executed' ? 'offered' : 'proposed';
  } catch (error) {
    // Booked meanwhile, or every candidate gone since the ranking.
    if (error instanceof SlotUnavailableError) return 'no_match';
    throw error;
  }
}
