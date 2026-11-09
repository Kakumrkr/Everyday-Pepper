import {
  claimMorning,
  findAvailabilityIn,
  listServicesIn,
  listStaffIn,
  morningHourOf,
  runInsightsFor,
  type InsightsOptions,
  type TemplateRuleDefaultsOf,
} from '@pepper/appointments';
import {
  addDays,
  ClientIdSchema,
  DRAFT_LIMITS,
  formatDate,
  RebookingDuePayloadSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  TemplateIdSchema,
  toZoned,
  type AvailableSlot,
  type TemplateDrafts,
  type TemplateId,
  type TenantId,
  type TrustJson,
  UserIdSchema,
} from '@pepper/contracts';
import { proposeForBusiness, type Actor, type Clock } from '@pepper/core';
import {
  findClient,
  linkFeedItemToProposal,
  listDraftableRebookings,
  listDueDraftRuns,
  listMemberships,
  readInsightTenant,
  withTenant,
  type Database,
  type DraftableRebooking,
  type TenantTx,
} from '@pepper/db';
import { daysOf } from '../tools/local-time.js';
import { sendRebookingNudge } from '../tools/catalog/nudges.js';
import { toolRefusalOf } from '../tools/errors.js';
import { clientFirstName } from '../tools/names.js';
import { writeRunner } from '../tools/runner.js';
import type { ToolDeps } from '../tools/tool.js';
import { draftReviewRequestsFor } from './review-requests.js';
import { writeDraft, type DraftFacts, type DraftWriterDeps } from './writer.js';

// The morning drafts pass (S36, ADR-0040; AC-W4-1, playbook D-3 and D-9): once a day, at the
// template's morning hour in the business's time zone, the worker refreshes the business's
// insights and turns each regular who is due back, and who can be emailed, into a rebooking
// email waiting under "Needs your OK": the domain finds a free time tomorrow for their service
// (their usual staff member first), the routine model writes the words, and the trust layer
// stores the proposal with its exact email, linked to the feed item. Nothing is sent until an
// owner or manager approves it. At most `DRAFT_LIMITS.perBusinessPerDay` drafts a business a
// day, and no client gets a second nudge within their interval. The worker's morning job runs
// it just before the daily briefing (S38a), which counts what it drafted. Then, when the business
// has a review link, it asks yesterday's clients for a review (S55.2, `review-requests.ts`).

const DAY_MS = 86_400_000;
/** Businesses per scan, and scans per pass. */
export const DRAFTS_BATCH = 50;
export const DRAFTS_BATCHES_PER_PASS = 4;

export interface MorningDraftsOptions extends Omit<DraftWriterDeps, 'provider'> {
  /**
   * The model that writes the rebooking nudges; `null` without one configured (S56a): the pass
   * still proposes the review requests, whose words are the domain's, and skips the nudges.
   */
  provider: DraftWriterDeps['provider'] | null;
  clock: Clock;
  /** For the nudge's links and its email (the api's and worker's `AUTH_BASE_URL`, outbox key). */
  emails: ToolDeps['emails'];
  /** The template's voice and morning hour (the worker passes `templateDrafts`). */
  draftsOf: (templateId: TemplateId | null) => TemplateDrafts;
  insightsOf: InsightsOptions['insightsOf'];
  templateRuleDefaults?: TemplateRuleDefaultsOf;
}

export type MorningDraftsResult =
  | { outcome: 'not_due' | 'waiting' | 'paused' | 'no_address' | 'gone' }
  | {
      outcome: 'ran';
      drafted: number;
      /** Review requests proposed this morning (S55.2): 0 without the business's review link. */
      reviewRequests: number;
      /** Review requests the domain refused (the client opted out meanwhile, the visit went). */
      reviewsRefused: number;
      /** The model's words broke a draft rule, or the domain refused the nudge. */
      refused: number;
      /** No free time tomorrow for their service. */
      noTime: number;
      /** The monthly token budget was used up. */
      noBudget: number;
      /** The model or a check failed unexpectedly (the next morning tries again). */
      failed: number;
    };

/** One pass of the morning drafts job: every business whose morning has come. */
export async function runDueMorningDrafts(
  db: Database,
  options: MorningDraftsOptions,
): Promise<{ businesses: number; drafted: number; reviewRequests: number; failed: number }> {
  const totals = { businesses: 0, drafted: 0, reviewRequests: 0, failed: 0 };
  const seen = new Set<TenantId>();
  for (let batch = 0; batch < DRAFTS_BATCHES_PER_PASS; batch += 1) {
    const due = await listDueDraftRuns(db, options.clock.now(), DRAFTS_BATCH);
    for (const tenantId of due) {
      if (seen.has(tenantId)) continue;
      seen.add(tenantId);
      const result = await runMorningDraftsFor(db, tenantId, options);
      if (result.outcome !== 'ran') continue;
      totals.businesses += 1;
      totals.drafted += result.drafted;
      totals.reviewRequests += result.reviewRequests;
      totals.failed += result.failed;
    }
    if (due.length < DRAFTS_BATCH) break;
  }
  return totals;
}

/**
 * Why a nudge's proposal was not made: the domain refused it (the time was booked meanwhile,
 * a sensitive word, the client opted out), or something broke (a bug, the database), which
 * the worker reports instead of counting it as a refusal.
 */
export function proposalFailureOf(error: unknown): 'refused' | 'failed' {
  return toolRefusalOf(error).code === 'internal' ? 'failed' : 'refused';
}

/** A due regular with what the writer and the nudge need. */
interface Candidate {
  item: DraftableRebooking;
  slot: AvailableSlot;
  serviceId: string;
  lastVisitAt: string;
  facts: DraftFacts;
}

/** Runs one business's morning drafts now, if its morning has come and nobody else took it. */
export async function runMorningDraftsFor(
  db: Database,
  tenantId: TenantId,
  options: MorningDraftsOptions,
): Promise<MorningDraftsResult> {
  const now = options.clock.now();
  const claim = await withTenant(db, tenantId, async (tx) => {
    const tenant = await readInsightTenant(tx);
    if (tenant === undefined) return { outcome: 'gone' as const };
    const drafts = options.draftsOf(TemplateIdSchema.nullable().parse(tenant.templateId));
    const today = toZoned(tenant.timeZone, now.getTime());
    // The business's own hour (S38a), else its template's: the briefing's hour too.
    const hour = morningHourOf(tenant.settings.morningHour, drafts.morningHour);
    const claimed = await claimMorning(tx, 'drafts', { timeZone: tenant.timeZone, hour }, now);
    if (claimed !== 'claimed') return { outcome: claimed };
    if (tenant.settings.suggestionsPaused) return { outcome: 'paused' as const };
    // Review requests (S55.2) go on when only the rebooking suggestions are turned off.
    // Without a model only the review requests run (S56a).
    const nudgesOn =
      !tenant.settings.disabledKinds.includes('rebooking_due') && options.provider !== null;
    const reviewsOn = tenant.reviewUrl !== null;
    if (!nudgesOn && !reviewsOn) return { outcome: 'paused' as const };
    if (tenant.mailingAddress === null) return { outcome: 'no_address' as const };
    const owner = (await listMemberships(tx)).find((member) => member.role === 'owner');
    if (owner === undefined) return { outcome: 'gone' as const };
    const parts = { nudges: nudgesOn, reviews: reviewsOn };
    return { outcome: 'claimed' as const, tenant, drafts, today, ownerId: owner.userId, parts };
  });
  if (claim.outcome !== 'claimed') return { outcome: claim.outcome };

  // The insights first, so the regulars and the open times are this morning's.
  await runInsightsFor(db, tenantId, { clock: options.clock, insightsOf: options.insightsOf });

  // The business's AI, acting for its owner: the domain's checks pass, and the proposals wait
  // for an owner or manager (ADR-0040).
  const ai: Actor = {
    context: { tenantId, userId: UserIdSchema.parse(claim.ownerId), role: 'owner' },
    requestId: `drafts-${formatDate(claim.today)}`,
    via: 'ai',
  };
  const tomorrow = formatDate(addDays(claim.today, 1));
  const result = { drafted: 0, refused: 0, noTime: 0, noBudget: 0, failed: 0 };
  const candidates = claim.parts.nudges
    ? await withTenant(db, tenantId, (tx) =>
        candidatesFor(tx, ai, {
          timeZone: claim.tenant.timeZone,
          tomorrow,
          now,
          business: { name: claim.tenant.name, voice: claim.drafts.voice },
          templateRuleDefaults: options.templateRuleDefaults,
          clock: options.clock,
          result,
        }),
      )
    : [];

  const deps: ToolDeps = {
    db,
    actor: ai,
    clock: options.clock,
    ...(options.templateRuleDefaults !== undefined && {
      templateRuleDefaults: options.templateRuleDefaults,
    }),
    autonomy: { templateDefaults: {} },
    emails: options.emails,
  };
  // Candidates exist only with a model (`parts.nudges`).
  const writer = options.provider;
  for (const candidate of candidates) {
    // Never true (no candidates without a model); it narrows `writer` for the call below.
    if (writer === null) break;
    let written: Awaited<ReturnType<typeof writeDraft>>;
    try {
      // Outside any transaction: a model call never holds one open.
      written = await writeDraft(
        { provider: writer, reserve: options.reserve },
        tenantId,
        candidate.facts,
      );
    } catch {
      result.failed += 1;
      continue;
    }
    if (written.kind === 'no_budget') {
      result.noBudget += 1;
      break;
    }
    if (written.kind === 'refused') {
      result.refused += 1;
      continue;
    }
    const payload: TrustJson = {
      clientId: candidate.item.clientId,
      serviceId: candidate.serviceId,
      staffMemberId: candidate.slot.staffMemberId,
      startsAt: candidate.slot.startsAt,
      lastVisitAt: candidate.lastVisitAt,
      draft: written.draft,
      // The model wrote these words: the email says so (S59.5, AC-X-55).
      wordsBy: 'ai',
    };
    try {
      await withTenant(db, tenantId, async (tx) => {
        const proposal = await proposeForBusiness(
          tx,
          ai,
          writeRunner(sendRebookingNudge, deps, payload).runner,
          {
            payload,
            idempotencyKey: `nudge.${candidate.item.itemId}.${formatDate(claim.today)}`,
            explanation: {
              requestMessageId: null,
              steps: [{ tool: 'write_draft', input: {} }],
              facts: [
                {
                  kind: 'rebooking_due',
                  ref: candidate.item.itemId,
                  value: RebookingDuePayloadSchema.parse(candidate.item.payload),
                },
              ],
              alternatives: [],
            },
            // The client's own name went to the model.
            untrustedContext: true,
          },
          { clock: options.clock },
        );
        await linkFeedItemToProposal(tx, candidate.item.itemId, proposal.id);
      });
      result.drafted += 1;
    } catch (error) {
      result[proposalFailureOf(error)] += 1;
    }
  }

  // Yesterday's visits (S55.2): a thank-you asking for a review, when the business has its link.
  let reviewRequests = 0;
  let reviewsRefused = 0;
  if (claim.parts.reviews) {
    const reviews = await draftReviewRequestsFor(db, tenantId, {
      ai,
      deps,
      timeZone: claim.tenant.timeZone,
      today: formatDate(claim.today),
      clock: options.clock,
    });
    reviewRequests = reviews.drafted;
    reviewsRefused = reviews.refused;
    result.failed += reviews.failed;
  }
  return { outcome: 'ran', ...result, reviewRequests, reviewsRefused };
}

/**
 * The due regulars who can be emailed, most overdue first, each with a free time tomorrow for
 * their last service (their staff member first, else anyone who offers it) and the facts the
 * writer may know.
 */
async function candidatesFor(
  tx: TenantTx,
  ai: Actor,
  context: {
    timeZone: string;
    tomorrow: string;
    now: Date;
    business: DraftFacts['business'];
    templateRuleDefaults: TemplateRuleDefaultsOf | undefined;
    clock: Clock;
    result: { noTime: number };
  },
): Promise<Candidate[]> {
  const items = await listDraftableRebookings(tx, context.now, DRAFT_LIMITS.perBusinessPerDay);
  if (items.length === 0) return [];
  const [services, staff] = [await listServicesIn(tx, ai), await listStaffIn(tx, ai)];
  const window = daysOf(context.timeZone, context.tomorrow);
  const options = {
    clock: context.clock,
    limit: 1,
    ...(context.templateRuleDefaults !== undefined && {
      templateRuleDefaults: context.templateRuleDefaults,
    }),
  };
  const candidates: Candidate[] = [];
  for (const item of items) {
    const payload = RebookingDuePayloadSchema.safeParse(item.payload);
    const service = services.find((each) => each.id === item.serviceId);
    if (!payload.success || service === undefined) continue;
    const serviceId = ServiceIdSchema.parse(service.id);
    const usual = staff.find(
      (each) =>
        each.id === item.staffMemberId && each.active && each.serviceIds.includes(serviceId),
    );
    const find = (staffMemberId?: string) =>
      findAvailabilityIn(
        tx,
        ai,
        {
          serviceId,
          ...(staffMemberId !== undefined && {
            staffMemberId: StaffMemberIdSchema.parse(staffMemberId),
          }),
          from: window.from,
          to: window.to,
        },
        options,
      );
    // Their staff member first; anyone who offers the service only when they have no time.
    let [slot] = usual === undefined ? [] : await find(usual.id);
    slot ??= (await find())[0];
    if (slot === undefined) {
      context.result.noTime += 1;
      continue;
    }
    const client = await findClient(tx, ClientIdSchema.parse(item.clientId));
    if (client === undefined) continue;
    const lastVisitAt = payload.data.lastVisitAt;
    candidates.push({
      item,
      slot,
      serviceId,
      lastVisitAt,
      facts: {
        business: context.business,
        // Typed by the client on the booking page: letters only, as the tools show it.
        clientFirstName: clientFirstName(client.name) ?? '',
        serviceName: service.name,
        // Only the staff member the client usually sees, and only when the time offered is
        // theirs: the email must not name one person and offer another's time.
        staffFirstName:
          usual?.id === slot.staffMemberId
            ? (usual.displayName.trim().split(/\s+/)[0] ?? null)
            : null,
        lastVisit: new Date(lastVisitAt).toLocaleDateString('en-US', {
          month: 'long',
          day: 'numeric',
          timeZone: context.timeZone,
        }),
        weeksSince: Math.max(
          1,
          Math.floor((context.now.getTime() - Date.parse(lastVisitAt)) / (7 * DAY_MS)),
        ),
      },
    });
  }
  return candidates;
}
