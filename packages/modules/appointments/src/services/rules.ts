import { BookingRulesSchema, type BookingRules, type BookingRulesInput } from '@floty/contracts';
import { requirePermission, type Actor } from '@floty/core';
import {
  appendAuditEntry,
  findStaffMemberIds,
  listBookingRules,
  lockBookingRules,
  replaceBookingRules as replaceBookingRuleRows,
  withTenant,
  type Database,
} from '@floty/db';
import { StaffMemberNotFoundError } from '../errors.js';
import { rowsToRules, sameValues } from '../mapping.js';

// The business's booking rules (ADR-0016). Everyone in the business may read them
// (`rules.read`); changing them needs `rules.manage` (owners and managers). The whole set is
// replaced at once, like a staff member's week, and audited in the same transaction.

/** The business's rules, sorted (business rules first, then per staff member). */
export async function getBookingRules(db: Database, actor: Actor): Promise<BookingRules> {
  requirePermission(actor, 'rules.read');
  return withTenant(db, actor.context.tenantId, async (tx) =>
    rowsToRules(await listBookingRules(tx)),
  );
}

/**
 * Replaces the business's whole rule set; an unchanged set is not audited. Every staff member
 * a rule names must be one of the business's (`StaffMemberNotFoundError`).
 */
export async function replaceBookingRules(
  db: Database,
  actor: Actor,
  input: BookingRulesInput,
): Promise<BookingRules> {
  requirePermission(actor, 'rules.manage');
  const { rules } = BookingRulesSchema.parse(input);
  return withTenant(db, actor.context.tenantId, async (tx) => {
    // Serialises concurrent changes, so the before/after in the audit log are exact.
    await lockBookingRules(tx);
    const named = [
      ...new Set(rules.flatMap((r) => (r.staffMemberId === null ? [] : [r.staffMemberId]))),
    ];
    if ((await findStaffMemberIds(tx, named)).length !== named.length) {
      throw new StaffMemberNotFoundError();
    }
    const before = rowsToRules(await listBookingRules(tx));
    await replaceBookingRuleRows(tx, rules);
    const after = rowsToRules(await listBookingRules(tx));
    if (!sameValues(before, after)) {
      await appendAuditEntry(tx, {
        actor: { kind: 'user', userId: actor.context.userId },
        change: {
          action: 'booking_rules.replaced',
          entity: { type: 'tenant', id: actor.context.tenantId },
          before,
          after,
        },
        requestId: actor.requestId,
      });
    }
    return after;
  });
}
