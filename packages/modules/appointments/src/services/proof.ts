import {
  BookingIdSchema,
  BookingStatusSchema,
  ClientIdSchema,
  PROOF_LIMITS,
  ProofResponseSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  type ProofResponse,
} from '@pepper/contracts';
import { systemClock, type Actor, type Clock } from '@pepper/core';
import {
  countWeekActions,
  findClientsByIds,
  findCurrentTenant,
  listInsightBookings,
  listWeekBookings,
  type TenantTx,
} from '@pepper/db';
import { buildEveningWrap, buildWeekValue } from '../insights/proof.js';
import { NO_SHOW_PATTERN } from '../insights/types.js';
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

  const wrap = buildEveningWrap(
    (
      await listInsightBookings(tx, new Date(now.getTime() - NO_SHOW_PATTERN.windowDays * DAY_MS))
    ).map((row) => ({
      id: BookingIdSchema.parse(row.id),
      clientId: ClientIdSchema.parse(row.clientId),
      serviceId: ServiceIdSchema.parse(row.serviceId),
      staffMemberId: StaffMemberIdSchema.parse(row.staffMemberId),
      start: row.startsAt.getTime(),
      end: row.endsAt.getTime(),
      bufferBeforeMinutes: row.bufferBeforeMinutes,
      bufferAfterMinutes: row.bufferAfterMinutes,
      status: BookingStatusSchema.parse(row.status),
    })),
    tenant.timeZone,
    now.getTime(),
  );
  let evening: ProofResponse['evening'] = null;
  if (wrap !== null) {
    const named = wrap.atRisk.slice(0, PROOF_LIMITS.atRiskNamed);
    const names = new Map(
      (
        await findClientsByIds(
          tx,
          named.map((visit) => visit.clientId),
        )
      ).map((row) => [row.id, row.name]),
    );
    evening = {
      day: wrap.day,
      visitCount: wrap.visitCount,
      firstStartsAt: wrap.firstStartsAt,
      atRiskCount: wrap.atRisk.length,
      atRisk: named.map((visit) => ({
        bookingId: visit.bookingId,
        clientName: names.get(visit.clientId) ?? 'Client',
        startsAt: visit.startsAt,
        noShowCount: visit.noShowCount,
      })),
    };
  }

  return ProofResponseSchema.parse({
    week: { from: from.toISOString(), to: now.toISOString(), ...week },
    evening,
  });
}
