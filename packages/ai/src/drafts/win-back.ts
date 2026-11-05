import {
  findAvailabilityIn,
  findWinBackEntries,
  listServicesIn,
  listStaffIn,
  requireWinBackAccess,
} from '@pepper/appointments';
import {
  ClientIdSchema,
  formatDate,
  fromZoned,
  ServiceIdSchema,
  StaffMemberIdSchema,
  toZoned,
  WIN_BACK_LIMITS,
  type AvailableSlot,
  type ClientId,
  type TrustJson,
  type WinBackDraftResult,
} from '@pepper/contracts';
import { NudgeNotSendableError, proposeForBusiness, type Actor } from '@pepper/core';
import {
  countWinBackDraftsSince,
  findCurrentTenant,
  findOpenRebookingItemOf,
  linkFeedItemToProposal,
  lockWinBackDrafts,
  WIN_BACK_KEY_PREFIX,
  withTenant,
  type TenantTx,
} from '@pepper/db';
import { drafted, firstAnswer, refused, winBackWords } from './win-back-words.js';
import { sendRebookingNudge } from '../tools/catalog/nudges.js';
import { clientFirstName } from '../tools/names.js';
import { writeRunner } from '../tools/runner.js';
import type { ToolDeps } from '../tools/tool.js';

// One-tap win-back drafts (S54.2, ADR-0057; AC-W4-7): an owner or manager taps "Draft email"
// on a client who hasn't been back, and the rebooking nudge of ADR-0040 is proposed for them,
// with the next open time for their last service (their own staff member first, within
// `WIN_BACK_LIMITS.searchDays`) and words the domain writes from the facts (no model call:
// the tap is the owner's own request, and an edit before the OK stays possible). It waits for
// an OK like every nudge, and the send checks the opt-out, the address and the time again.
// At most `WIN_BACK_LIMITS.perBusinessPerDay` taps' drafts a business a day (besides the morning
// pass's own); no client gets one within the
// quiet window of a nudge or a regular's offer; a second tap returns the draft that waits.

const DAY_MS = 86_400_000;

/** Drafts the win-back email for `clientId`, or says why it can't. */
export async function draftWinBack(
  deps: ToolDeps,
  clientIdInput: ClientId,
  /** Tests lower the daily cap; the app uses `WIN_BACK_LIMITS.perBusinessPerDay`. */
  options: { perBusinessPerDay?: number } = {},
): Promise<WinBackDraftResult> {
  const member = deps.actor;
  requireWinBackAccess(member);
  const clientId = ClientIdSchema.parse(clientIdInput);
  const now = deps.clock.now();
  return withTenant(deps.db, member.context.tenantId, async (tx) => {
    const tenant = await findCurrentTenant(tx);
    if (tenant === undefined) throw new Error('No business in this transaction');
    const entry = (await findWinBackEntries(tx, member, now)).find(
      (each) => each.clientId === clientId,
    );
    const first = firstAnswer(entry, tenant.mailingAddress !== null);
    if (first !== null) return first;
    if (entry === undefined) return refused('not_due');
    const today = toZoned(tenant.timeZone, now.getTime());
    const midnight = new Date(fromZoned(tenant.timeZone, today, 0));
    const cap = options.perBusinessPerDay ?? WIN_BACK_LIMITS.perBusinessPerDay;
    // Two taps at once count one after the other (the lock holds until this transaction ends).
    await lockWinBackDrafts(tx);
    if ((await countWinBackDraftsSince(tx, midnight)) >= cap) {
      return refused('daily_limit');
    }

    const ai: Actor = { ...member, via: 'ai' };
    const open = await nextOpenTime(tx, ai, deps, {
      serviceId: entry.serviceId,
      staffMemberId: entry.staffMemberId,
      now,
    });
    if (open === undefined) return refused('no_time');
    const { slot, serviceName } = open;
    const lastVisitAt = new Date(entry.lastVisitAt).toISOString();
    const payload: TrustJson = {
      clientId,
      serviceId: entry.serviceId,
      staffMemberId: slot.staffMemberId,
      startsAt: slot.startsAt,
      lastVisitAt,
      draft: winBackWords({
        firstName: clientFirstName(entry.name) ?? null,
        serviceName,
        lastVisit: new Date(lastVisitAt).toLocaleDateString('en-US', {
          month: 'long',
          day: 'numeric',
          timeZone: tenant.timeZone,
        }),
      }),
    };
    try {
      const proposal = await proposeForBusiness(
        tx,
        ai,
        writeRunner(sendRebookingNudge, deps, payload).runner,
        {
          payload,
          idempotencyKey: `${WIN_BACK_KEY_PREFIX}${clientId}.${formatDate(today)}`,
          explanation: {
            requestMessageId: null,
            steps: [{ tool: 'win_back', input: {} }],
            facts: [
              {
                kind: 'win_back',
                ref: null,
                value: {
                  lastVisitAt,
                  dueOn: entry.dueOn,
                  daysOverdue: entry.daysOverdue,
                  visits: entry.visits,
                },
              },
            ],
            alternatives: [],
          },
          // The client's own name is in the words, and it came from outside the team.
          untrustedContext: true,
        },
        { clock: deps.clock, requestedBy: member },
      );
      // Its feed card, if the regular is still on the feed, now waits for this OK.
      const item = await findOpenRebookingItemOf(tx, clientId, now);
      if (item !== undefined) await linkFeedItemToProposal(tx, item, proposal.id);
      return drafted(proposal.id);
    } catch (error) {
      // The send's own checks, met between the list and the tap.
      if (error instanceof NudgeNotSendableError) return refused(error.reason);
      throw error;
    }
  });
}

/** Their staff member's first open time for the service; else anyone's who offers it. */
async function nextOpenTime(
  tx: TenantTx,
  ai: Actor,
  deps: ToolDeps,
  input: { serviceId: string; staffMemberId: string; now: Date },
): Promise<{ slot: AvailableSlot; serviceName: string } | undefined> {
  const services = await listServicesIn(tx, ai);
  const service = services.find((each) => each.id === input.serviceId);
  if (!service?.active) return undefined;
  const serviceId = ServiceIdSchema.parse(service.id);
  const staff = await listStaffIn(tx, ai);
  const usual = staff.find(
    (each) => each.id === input.staffMemberId && each.active && each.serviceIds.includes(serviceId),
  );
  const from = input.now.toISOString();
  const to = new Date(input.now.getTime() + WIN_BACK_LIMITS.searchDays * DAY_MS).toISOString();
  const options = {
    clock: deps.clock,
    limit: 1,
    ...(deps.templateRuleDefaults !== undefined && {
      templateRuleDefaults: deps.templateRuleDefaults,
    }),
  };
  const find = (staffMemberId?: string) =>
    findAvailabilityIn(
      tx,
      ai,
      {
        serviceId,
        ...(staffMemberId !== undefined && {
          staffMemberId: StaffMemberIdSchema.parse(staffMemberId),
        }),
        from,
        to,
      },
      options,
    );
  const [own] = usual === undefined ? [] : await find(usual.id);
  const slot = own ?? (await find())[0];
  return slot === undefined ? undefined : { slot, serviceName: service.name };
}
