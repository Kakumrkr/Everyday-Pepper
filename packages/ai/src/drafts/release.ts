import {
  BookingNotReleasableError,
  releaseTargetKey,
  type TemplateRuleDefaultsOf,
} from '@pepper/appointments';
import { UserIdSchema, type BookingId, type TenantId } from '@pepper/contracts';
import { proposeForBusiness, type Actor, type Clock } from '@pepper/core';
import {
  countSupersededProposalsFor,
  listMemberships,
  lockBooking,
  type Database,
  type TenantTx,
} from '@pepper/db';
import { releaseUnconfirmedBooking } from '../tools/catalog/release.js';
import { writeRunner } from '../tools/runner.js';
import type { ToolDeps } from '../tools/tool.js';

// The release card's proposer (S78.2, ADR-0071 §S78.2; AC-X-207): the reminder job calls it at a
// visit's confirm cut-off, in the reminder's transaction, once the domain's rules say the visit
// may be released. It stores one card waiting for an owner or manager; it never releases. A card
// that can't be made rolls back only itself, never the reminder job.

export interface ReleaseProposerOptions {
  db: Database;
  clock: Clock;
  /** For the release email the approval queues (the worker's `AUTH_BASE_URL`, outbox key). */
  emails: ToolDeps['emails'];
  templateRuleDefaults?: TemplateRuleDefaultsOf;
  /** Told about a failure that isn't the domain refusing the card, so the worker can log it. */
  onUnexpected?: (error: unknown) => void;
}

/**
 * Proposes the release card for `bookingId` in `tx` (the business's), as its AI for the owner:
 * whether a card now waits. Idempotent by visit and time: a second call, or a second pass, makes
 * no second card; one a new cut-off took away can come back.
 */
export async function proposeReleaseIn(
  tx: TenantTx,
  tenantId: TenantId,
  bookingId: BookingId,
  options: ReleaseProposerOptions,
): Promise<boolean> {
  const booking = await lockBooking(tx, bookingId);
  if (booking === undefined) return false;
  const owner = (await listMemberships(tx)).find((member) => member.role === 'owner');
  if (owner === undefined) return false;
  const ai: Actor = {
    context: { tenantId, userId: UserIdSchema.parse(owner.userId), role: 'owner' },
    requestId: `release-${bookingId}`,
    via: 'ai',
  };
  const deps: ToolDeps = {
    db: options.db,
    actor: ai,
    clock: options.clock,
    ...(options.templateRuleDefaults !== undefined && {
      templateRuleDefaults: options.templateRuleDefaults,
    }),
    // `booking.release` asks in every preset: the template's levels don't change it.
    autonomy: { templateDefaults: {} },
    emails: options.emails,
  };
  // By visit and time; a card a new cut-off took away (S78.3) comes back under a new key.
  const withdrawn = await countSupersededProposalsFor(tx, releaseTargetKey(bookingId));
  const again = withdrawn === 0 ? '' : `.${String(withdrawn)}`;
  const startsAt = booking.startsAt.toISOString();
  const payload = { bookingId, startsAt };
  try {
    await tx.transaction((savepoint) =>
      proposeForBusiness(
        savepoint,
        ai,
        writeRunner(releaseUnconfirmedBooking, deps, payload).runner,
        {
          payload,
          idempotencyKey: `release.${bookingId}.${String(booking.startsAt.getTime())}${again}`,
          explanation: {
            requestMessageId: null,
            steps: [{ tool: 'release_check', input: {} }],
            facts: [],
            alternatives: [],
          },
          // The client's own name is in the card, and it came from outside the team.
          untrustedContext: true,
        },
        { clock: options.clock },
      ),
    );
    return true;
  } catch (error) {
    // The domain refusing the card (confirmed or changed meanwhile) is an answer, not a failure.
    if (!(error instanceof BookingNotReleasableError)) options.onUnexpected?.(error);
    return false;
  }
}
