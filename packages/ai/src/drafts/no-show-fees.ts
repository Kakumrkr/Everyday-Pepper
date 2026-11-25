import { UserIdSchema, type ActionProposal } from '@pepper/contracts';
import { proposeForBusiness, type Actor } from '@pepper/core';
import { listMemberships, type TenantTx } from '@pepper/db';
import { NoShowFeeNotChargeableError, noShowFeeOfferIn } from '@pepper/payments';
import { chargeNoShowFee } from '../tools/catalog/no-show-fees.js';
import { writeRunner } from '../tools/runner.js';
import type { ToolDeps } from '../tools/tool.js';

// The no-show fee card (S68, ADR-0068 amendment; AC-X-137): when a visit is marked a no-show,
// by the team or by Pepper, the no-show's own transaction proposes one card for the fee the
// client's stored terms allow, less a kept deposit. It never charges: the owner approves or
// waives it. A visit with nothing to charge gets no card; the no-show never fails because of it.

/**
 * Proposes the fee card for `bookingId` in the caller's transaction, or answers `null` when there
 * is nothing to charge. Idempotent by booking; the dry run runs as the business's AI for its owner
 * (the domain's checks pass), the card is requested by the member who marked the no-show
 * (`deps.actor`), and it waits for an owner's OK.
 */
export async function proposeNoShowFeeIn(
  tx: TenantTx,
  deps: ToolDeps,
  bookingId: string,
  options: {
    /**
     * Told about a failure that isn't the domain refusing the card (a bug, the database), so the
     * app can log it (review: never silently lost); the no-show stands either way.
     */
    onUnexpected?: (error: unknown) => void;
  } = {},
): Promise<ActionProposal | null> {
  const offer = await noShowFeeOfferIn(tx, bookingId);
  if (typeof offer === 'string') return null;
  const owner = (await listMemberships(tx)).find((member) => member.role === 'owner');
  if (owner === undefined) return null;
  const ai: Actor = {
    context: {
      tenantId: deps.actor.context.tenantId,
      userId: UserIdSchema.parse(owner.userId),
      role: 'owner',
    },
    requestId: deps.actor.requestId,
    via: 'ai',
  };
  const payload = { bookingId, chargeCents: offer.chargeCents };
  // In a savepoint: a card that can't be made rolls back only itself, never the no-show.
  try {
    return await tx.transaction((savepoint) =>
      proposeForBusiness(
        savepoint,
        ai,
        writeRunner(chargeNoShowFee, { ...deps, actor: ai }, payload).runner,
        {
          payload,
          idempotencyKey: `fee.no_show.${bookingId}`,
          explanation: {
            requestMessageId: null,
            steps: [{ tool: 'no_show_fee', input: {} }],
            facts: [],
            alternatives: [],
          },
          // The client's own name is in the card, and it came from outside the team.
          untrustedContext: true,
        },
        // Requested by the member who marked the no-show: their own transaction may store it
        // (the proposals' member rule), the audit names them, and it still waits for an
        // owner's OK (`payment.no_show_fee` needs `payments.manage`).
        { clock: deps.clock, requestedBy: deps.actor },
      ),
    );
  } catch (error) {
    // The domain refusing the card (the visit or the card changed) is an answer, not a failure.
    if (!(error instanceof NoShowFeeNotChargeableError)) options.onUnexpected?.(error);
    return null;
  }
}
