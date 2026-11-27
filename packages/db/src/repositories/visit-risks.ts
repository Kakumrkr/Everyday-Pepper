import {
  BookingIdSchema,
  VisitRiskBandSchema,
  VisitRiskReasonsSchema,
  type BookingId,
  type VisitRisk,
} from '@pepper/contracts';
import { inArray, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { visitRisks } from '../schema.js';
import type { TenantTx } from '../tenant.js';

// Upcoming visits' risk bands (S77, ADR-0071). The insights pass writes them; owners and
// managers read them (the table's member scope keeps staff out even if a check is missed).

const Id = z.uuid();

/** A visit's risk as the pass computed it. */
export interface VisitRiskInput extends VisitRisk {
  bookingId: BookingId;
}

export interface VisitRiskSyncResult {
  /** Rows inserted or changed (a band, points or reasons that moved). */
  written: number;
  /** Rows removed: the visit is no longer upcoming and confirmed. */
  removed: number;
}

/**
 * Makes the table hold exactly `risks`: new visits are inserted, a row changes only when its
 * band, points or reasons changed (so a second run on the same data writes nothing), and rows
 * for any other visit are removed.
 */
export async function syncVisitRisks(
  tx: TenantTx,
  risks: readonly VisitRiskInput[],
  now: Date,
): Promise<VisitRiskSyncResult> {
  let written = 0;
  const ids: string[] = [];
  for (let i = 0; i < risks.length; i += 500) {
    const values = risks.slice(i, i + 500).map((risk) => {
      const bookingId = Id.parse(risk.bookingId);
      ids.push(bookingId);
      return {
        bookingId,
        band: VisitRiskBandSchema.parse(risk.band),
        points: z.number().int().min(0).max(20).parse(risk.points),
        reasons: VisitRiskReasonsSchema.parse(risk.reasons),
        computedAt: now,
      };
    });
    const rows = await tx
      .insert(visitRisks)
      .values(values)
      .onConflictDoUpdate({
        target: [visitRisks.tenantId, visitRisks.bookingId],
        set: {
          band: sql`excluded.band`,
          points: sql`excluded.points`,
          reasons: sql`excluded.reasons`,
          computedAt: sql`excluded.computed_at`,
        },
        setWhere: sql`${visitRisks.band} IS DISTINCT FROM excluded.band OR ${visitRisks.points} IS DISTINCT FROM excluded.points OR ${visitRisks.reasons} IS DISTINCT FROM excluded.reasons`,
      })
      .returning({ id: visitRisks.id });
    written += rows.length;
  }
  const removed = await tx
    .delete(visitRisks)
    .where(ids.length === 0 ? sql`true` : notInArray(visitRisks.bookingId, ids))
    .returning({ id: visitRisks.id });
  return { written, removed: removed.length };
}

/** A stored visit risk. */
export interface VisitRiskRow extends VisitRisk {
  bookingId: BookingId;
  computedAt: Date;
}

/** The stored risks of these visits (owners and managers; staff read none, by RLS). */
export async function listVisitRisks(
  tx: TenantTx,
  bookingIds: readonly BookingId[],
): Promise<VisitRiskRow[]> {
  if (bookingIds.length === 0) return [];
  const rows = await tx
    .select()
    .from(visitRisks)
    .where(
      inArray(
        visitRisks.bookingId,
        bookingIds.map((id) => Id.parse(id)),
      ),
    );
  return rows.flatMap((row) => {
    // A row is written through the schema; one that no longer parses is skipped, not trusted.
    const reasons = VisitRiskReasonsSchema.safeParse(row.reasons);
    const band = VisitRiskBandSchema.safeParse(row.band);
    if (!reasons.success || !band.success) return [];
    return [
      {
        bookingId: BookingIdSchema.parse(row.bookingId),
        band: band.data,
        points: row.points,
        reasons: reasons.data,
        computedAt: row.computedAt,
      },
    ];
  });
}
