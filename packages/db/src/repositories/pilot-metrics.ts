import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { TenantTx } from '../tenant.js';

/**
 * The pilot metrics page's numbers (S59.4, ADR-0062, AC-X-47…49). Both reads need a logged
 * operator transaction (`withOperator` with `metrics.read`): the platform's through the
 * `operator_pilot_metrics` definer function, support's through the operator policies.
 * Counts and minutes only.
 */

const Count = z.number().int().nonnegative();
const Minutes = z.coerce.number().nonnegative().nullable();

const PlatformMetricsSchema = z.object({
  businesses: Count,
  bookableBusinesses: Count,
  signups: Count,
  reachedBookable: Count,
  reachedFirstBooking: Count,
  minutesToBookable: Minutes,
  minutesToFirstBooking: Minutes,
  funnelStarts: Count,
  funnelConfirmed: Count,
  funnelReachedCode: Count,
  funnelLeftAtCode: Count,
  pastBookings: Count,
  noShows: Count,
  cancelledSlots: Count,
  refilledSlots: Count,
  offersSent: Count,
  offersClaimed: Count,
});
export type PlatformMetrics = z.infer<typeof PlatformMetricsSchema>;

/**
 * Every business's activation, public funnel, bookings and waitlist offers from `since` to
 * `until`: sign-ups of the period and how many reached bookable and a first booking (with the
 * medians in minutes), funnel visits that started in it, past visits and no-shows, slots
 * cancelled ahead of their time and refilled, offers sent and claimed.
 */
export async function readPlatformMetrics(
  tx: TenantTx,
  period: { since: Date; until: Date },
): Promise<PlatformMetrics> {
  const since = z.date().parse(period.since).toISOString();
  const until = z.date().parse(period.until).toISOString();
  const { rows } = await tx.execute<{ metrics: unknown }>(
    sql`SELECT operator_pilot_metrics(${since}::timestamptz, ${until}::timestamptz) AS metrics`,
  );
  return PlatformMetricsSchema.parse(rows[0]?.metrics);
}

const SupportMetricsSchema = z.object({
  requests: Count,
  answered: Count,
  answered_within_day: Count,
  waiting: Count,
  waiting_over_day: Count,
  median_minutes: Minutes,
  slowest_minutes: Minutes,
  requests_in_app: Count,
  requests_by_email: Count,
  replies_in_app: Count,
  replies_by_email: Count,
  public_by_form: Count,
  public_by_email: Count,
  public_answered: Count,
  public_open: Count,
});

export interface SupportMetrics {
  /** Business requests opened in the period (their first member message in it). */
  requests: number;
  answered: number;
  answeredWithinDay: number;
  /** Not answered yet; those opened more than a day before `until`. */
  waiting: number;
  waitingOverDay: number;
  /** From the first message to the team's first reply, of the answered ones. */
  medianMinutes: number | null;
  slowestMinutes: number | null;
  requestsInApp: number;
  requestsByEmail: number;
  /** Members' later messages in the period, by channel. */
  repliesInApp: number;
  repliesByEmail: number;
  /** Public requests made in the period, by channel and status. */
  publicByForm: number;
  publicByEmail: number;
  publicAnswered: number;
  publicOpen: number;
}

/** First-reply time and the requests by channel, from `since` to `until` (AC-X-48, AC-X-49). */
export async function readSupportMetrics(
  tx: TenantTx,
  period: { since: Date; until: Date },
): Promise<SupportMetrics> {
  const since = z.date().parse(period.since).toISOString();
  const until = z.date().parse(period.until).toISOString();
  const { rows } = await tx.execute(sql`
    WITH opened AS (
      SELECT DISTINCT ON (m.thread_id) m.tenant_id, m.thread_id, m.created_at AS opened_at,
             m.channel
        FROM support_messages m
       WHERE m.author_kind = 'member' AND m.created_at <= ${until}::timestamptz
       ORDER BY m.thread_id, m.created_at, m.id
    ),
    requests AS (
      SELECT o.opened_at, o.channel,
             (SELECT min(p.created_at) FROM support_messages p
               WHERE p.tenant_id = o.tenant_id AND p.thread_id = o.thread_id
                 AND p.author_kind = 'pepper'
                 AND p.created_at >= o.opened_at AND p.created_at <= ${until}::timestamptz)
               AS replied_at
        FROM opened o
       WHERE o.opened_at >= ${since}::timestamptz AND o.opened_at <= ${until}::timestamptz
    ),
    replies AS (
      SELECT m.channel
        FROM support_messages m
        JOIN opened o ON o.tenant_id = m.tenant_id AND o.thread_id = m.thread_id
       WHERE m.author_kind = 'member' AND m.created_at > o.opened_at
         AND m.created_at >= ${since}::timestamptz AND m.created_at <= ${until}::timestamptz
    ),
    public_requests AS (
      SELECT r.channel, r.status
        FROM public_support_requests r
       WHERE r.created_at >= ${since}::timestamptz AND r.created_at <= ${until}::timestamptz
    )
    SELECT
      (SELECT count(*) FROM requests)::int AS requests,
      (SELECT count(*) FROM requests WHERE replied_at IS NOT NULL)::int AS answered,
      (SELECT count(*) FROM requests
        WHERE replied_at IS NOT NULL AND replied_at - opened_at <= interval '1 day')::int
        AS answered_within_day,
      (SELECT count(*) FROM requests WHERE replied_at IS NULL)::int AS waiting,
      (SELECT count(*) FROM requests
        WHERE replied_at IS NULL AND ${until}::timestamptz - opened_at > interval '1 day')::int
        AS waiting_over_day,
      (SELECT percentile_cont(0.5) WITHIN GROUP (
                ORDER BY extract(epoch FROM replied_at - opened_at) / 60)
         FROM requests WHERE replied_at IS NOT NULL) AS median_minutes,
      (SELECT max(extract(epoch FROM replied_at - opened_at) / 60)
         FROM requests WHERE replied_at IS NOT NULL) AS slowest_minutes,
      (SELECT count(*) FROM requests WHERE channel = 'app')::int AS requests_in_app,
      (SELECT count(*) FROM requests WHERE channel = 'email')::int AS requests_by_email,
      (SELECT count(*) FROM replies WHERE channel = 'app')::int AS replies_in_app,
      (SELECT count(*) FROM replies WHERE channel = 'email')::int AS replies_by_email,
      (SELECT count(*) FROM public_requests WHERE channel = 'form')::int AS public_by_form,
      (SELECT count(*) FROM public_requests WHERE channel = 'email')::int AS public_by_email,
      (SELECT count(*) FROM public_requests WHERE status <> 'open')::int AS public_answered,
      (SELECT count(*) FROM public_requests WHERE status = 'open')::int AS public_open`);
  const row = SupportMetricsSchema.parse(rows[0]);
  return {
    requests: row.requests,
    answered: row.answered,
    answeredWithinDay: row.answered_within_day,
    waiting: row.waiting,
    waitingOverDay: row.waiting_over_day,
    medianMinutes: row.median_minutes,
    slowestMinutes: row.slowest_minutes,
    requestsInApp: row.requests_in_app,
    requestsByEmail: row.requests_by_email,
    repliesInApp: row.replies_in_app,
    repliesByEmail: row.replies_by_email,
    publicByForm: row.public_by_form,
    publicByEmail: row.public_by_email,
    publicAnswered: row.public_answered,
    publicOpen: row.public_open,
  };
}
