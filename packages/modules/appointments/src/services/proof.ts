import { PROOF_LIMITS, ProofResponseSchema, type ProofResponse } from '@pepper/contracts';
import { systemClock, type Actor, type Clock } from '@pepper/core';
import {
  countWeekActions,
  findClientsByIds,
  findCurrentTenant,
  listInsightBookings,
  listWeekBookings,
  type TenantTx,
} from '@pepper/db';
import { buildEveningWrap, buildWeekValue, isEvening } from '../insights/proof.js';
import { INSIGHT_HISTORY_DAYS } from '../insights/types.js';
import { toInsightBooking } from './insights.js';
import { requireWinBackAccess } from './win-back.js';

// Proof of value (S55, ADR-0058; AC-W4-10…13): the week card and the evening wrap, read when
// Home asks, so a fill or a booking shows the moment it happens, with no worker pass. Owners
// and managers only, as for "Haven't been back": the dollars and the names are the business's.

const DAY_MS = 86_400_000;

/** `GET /v1/proof`: what Pepper did in the last 7 days, and tomorrow from the evening hour. */
export async function readProofIn(
  tx: TenantTx,
  actor: Actor,
  options: { clock?: Clock } = {},
): Promise<ProofResponse> {
  requireWinBackAccess(actor);
  const now = (options.clock ?? systemClock).now();
  const tenant = await findCurrentTenant(tx);
  if (tenant === undefined) throw new Error('No business in this transaction');

  const from = new Date(now.getTime() - PROOF_LIMITS.weekDays * DAY_MS);
  const week = buildWeekValue(
    await listWeekBookings(tx, { from, to: now, regularBackDays: PROOF_LIMITS.regularBackDays }),
    await countWeekActions(tx, { from, to: now }),
  );

  // The history is read only in the evening, when the wrap shows.
  const evening = isEvening(tenant.timeZone, now.getTime())
    ? await readEveningWrap(tx, tenant.timeZone, tenant.depositRefundHours, now)
    : null;
  return ProofResponseSchema.parse({
    week: { from: from.toISOString(), to: now.toISOString(), ...week },
    evening,
  });
}

/** Tomorrow's wrap with the at-risk clients' names. */
async function readEveningWrap(
  tx: TenantTx,
  timeZone: string,
  cancelNoticeHours: number,
  now: Date,
): Promise<ProofResponse['evening']> {
  const wrap = buildEveningWrap(
    (await listInsightBookings(tx, new Date(now.getTime() - INSIGHT_HISTORY_DAYS * DAY_MS))).map(
      toInsightBooking,
    ),
    timeZone,
    now.getTime(),
    cancelNoticeHours,
  );
  if (wrap === null) return null;
  const named = wrap.atRisk.slice(0, PROOF_LIMITS.atRiskNamed);
  const names = new Map(
    (
      await findClientsByIds(
        tx,
        named.map((visit) => visit.clientId),
      )
    ).map((row) => [row.id, row.name]),
  );
  return {
    day: wrap.day,
    visitCount: wrap.visitCount,
    firstStartsAt: wrap.firstStartsAt,
    atRiskCount: wrap.atRisk.length,
    atRisk: named.map((visit) => ({
      bookingId: visit.bookingId,
      clientName: names.get(visit.clientId) ?? 'Client',
      startsAt: visit.startsAt,
      topReason: visit.topReason,
    })),
  };
}
