import {
  addDays,
  fromZoned,
  StaffMemberIdSchema,
  TemplateIdSchema,
  toZoned,
  UserIdSchema,
  type StaffMemberId,
  type TemplateId,
  type TenantId,
} from '@pepper/contracts';
import { leadUserIds, queuePushToMembers } from '@pepper/core';
import {
  briefingCounts,
  claimMorningRun,
  listDueMorningRuns,
  listMemberships,
  listStaffMembers,
  readInsightTenant,
  waitlistActivity,
  withTenant,
  writeBriefings,
  type Database,
} from '@pepper/db';
import { buildBriefings } from '../insights/briefing.js';
import { briefingPush } from '../pushes.js';
import { loadSnapshot, runInsightsFor, type InsightsOptions } from './insights.js';

// The daily briefing (S38a, ADR-0042; playbook F-4): once a day per business, at its morning
// hour in its time zone (the business's setting, else its template's), the worker refreshes
// the insights, counts the day ahead and writes one briefing for the business (owners and
// managers) and one for each staff member's own day, then pushes each to its readers: numbers
// only, worded by a template, no model and no email. It runs while suggestions are paused (it
// only informs). The claim is the drafts pass's pattern on its own column, so a business is
// briefed once a morning however many workers run.

const DAY_MS = 86_400_000;
/** Businesses per scan, and scans per pass. */
export const BRIEFING_BATCH = 50;
export const BRIEFING_BATCHES_PER_PASS = 4;

export interface BriefingOptions extends InsightsOptions {
  /** The template's morning hour (the worker passes `templateDrafts`; L2 never imports L3). */
  morningHourOf: (templateId: TemplateId | null) => number;
  /** Seals the pushes in the outbox; `null`: this worker sends no pushes. */
  pushKey: Buffer | null;
}

export type BriefingResult =
  { outcome: 'waiting' | 'not_due' | 'gone' } | { outcome: 'ran'; written: number; pushes: number };

/** One pass of the briefing job: every business whose morning has come. */
export async function runDueBriefings(
  db: Database,
  options: BriefingOptions,
): Promise<{ businesses: number; written: number; pushes: number }> {
  const totals = { businesses: 0, written: 0, pushes: 0 };
  const seen = new Set<TenantId>();
  for (let batch = 0; batch < BRIEFING_BATCHES_PER_PASS; batch += 1) {
    const due = await listDueMorningRuns(
      db,
      'briefing',
      new Date(options.clock.now()),
      BRIEFING_BATCH,
    );
    for (const tenantId of due) {
      if (seen.has(tenantId)) continue;
      seen.add(tenantId);
      const result = await runBriefingFor(db, tenantId, options);
      if (result.outcome !== 'ran') continue;
      totals.businesses += 1;
      totals.written += result.written;
      totals.pushes += result.pushes;
    }
    if (due.length < BRIEFING_BATCH) break;
  }
  return totals;
}

/** Briefs one business now, if its morning has come and nobody else took it. */
export async function runBriefingFor(
  db: Database,
  tenantId: TenantId,
  options: BriefingOptions,
): Promise<BriefingResult> {
  const now = new Date(options.clock.now());
  const claim = await withTenant(db, tenantId, async (tx) => {
    const tenant = await readInsightTenant(tx);
    if (tenant === undefined) return { outcome: 'gone' as const };
    const templateId = TemplateIdSchema.nullable().catch(null).parse(tenant.templateId);
    const hour = tenant.settings.morningHour ?? options.morningHourOf(templateId);
    const today = toZoned(tenant.timeZone, now.getTime());
    const morningOf = (offset: number) =>
      new Date(fromZoned(tenant.timeZone, addDays(today, offset), hour * 60));
    // Before this morning's hour: wait for it (a business's first day included).
    if (now < morningOf(0)) {
      await claimMorningRun(tx, 'briefing', now, morningOf(0));
      return { outcome: 'waiting' as const };
    }
    if (!(await claimMorningRun(tx, 'briefing', now, morningOf(1)))) {
      return { outcome: 'not_due' as const };
    }
    return { outcome: 'claimed' as const, timeZone: tenant.timeZone, templateId };
  });
  if (claim.outcome !== 'claimed') return { outcome: claim.outcome };

  // The insights first, so the gaps, the regulars due and the waitlist are this morning's.
  await runInsightsFor(db, tenantId, options);

  return withTenant(db, tenantId, async (tx) => {
    const template = options.insightsOf(claim.templateId);
    const snapshot = await loadSnapshot(tx, {
      now: now.getTime(),
      timeZone: claim.timeZone,
      minGapMinutes: template.minGapMinutes,
    });
    const [counts, waitlist, staff, members] = [
      await briefingCounts(tx, now),
      await waitlistActivity(tx, now, new Date(now.getTime() - DAY_MS)),
      await listStaffMembers(tx),
      await listMemberships(tx),
    ];
    // Owners and managers read the business's briefing; only the staff role gets its own day.
    const staffUsers = new Set(
      members.filter((member) => member.role === 'staff').map((member) => member.userId),
    );
    const userOf = new Map<StaffMemberId, string>();
    for (const row of staff) {
      if (row.userId !== null && staffUsers.has(row.userId)) {
        userOf.set(StaffMemberIdSchema.parse(row.id), row.userId);
      }
    }
    const briefings = buildBriefings(snapshot, {
      ownDayStaff: [...userOf.keys()],
      needsOk: counts.needsOk,
      rebookingDue: counts.rebookingDue,
      waitlist,
    });
    const written = await writeBriefings(
      tx,
      briefings.map((briefing) => ({ ...briefing, expiresAt: new Date(briefing.expiresAt) })),
    );

    let pushes = 0;
    if (options.pushKey !== null) {
      for (const briefing of briefings) {
        const recipient =
          briefing.staffMemberId === null ? undefined : userOf.get(briefing.staffMemberId);
        const users =
          briefing.staffMemberId === null
            ? await leadUserIds(tx)
            : recipient === undefined
              ? []
              : [UserIdSchema.parse(recipient)];
        const queued = await queuePushToMembers(
          tx,
          users,
          briefingPush(briefing.payload, claim.timeZone),
          {
            key: options.pushKey,
            dedupeKey: `push.briefing:${briefing.staffMemberId ?? 'business'}:${briefing.day}`,
            now,
          },
        );
        pushes += queued.length;
      }
    }
    return { outcome: 'ran' as const, written, pushes };
  });
}
