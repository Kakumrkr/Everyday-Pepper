import { PilotMetricsSchema, type PilotMetric, type PilotMetrics } from '@pepper/contracts';
import { Badge, cx, DetailTable, FOCUS_RING, List, ListRow, Stat } from '@pepper/ui';
import Link from 'next/link';
import { OPS_PATHS } from '../../../lib/ops';
import {
  channelRows,
  firstReplyRows,
  metricValueWords,
  metricsDays,
  PILOT_METRIC_GROUPS,
  PILOT_METRIC_LABEL,
  PILOT_METRIC_STATUS,
  PILOT_METRICS_PERIOD_LABEL,
  sampleWords,
  targetWords,
} from '../../../lib/pilot-metrics';
import { currentJson } from '../../_server/account';

export const dynamic = 'force-dynamic';

function StatusBadge({ metric }: { metric: PilotMetric }) {
  const status = PILOT_METRIC_STATUS[metric.status];
  return <Badge tone={status.tone}>{status.label}</Badge>;
}

function MetricRow({ metric }: { metric: PilotMetric }) {
  return (
    <ListRow
      title={PILOT_METRIC_LABEL[metric.key]}
      meta={`${targetWords(metric.key)} · ${sampleWords(metric.key, metric.sample)}`}
      trailing={
        <span className="flex flex-col items-end gap-1">
          <span className="type-title text-ink tabular-nums" data-testid={`metric-${metric.key}`}>
            {metricValueWords(metric)}
          </span>
          <StatusBadge metric={metric} />
        </span>
      }
    />
  );
}

function FirstReply({ metrics }: { metrics: PilotMetrics }) {
  const metric = metrics.metrics.find((item) => item.key === 'first_reply_time');
  if (metric === undefined) return null;
  return (
    <section aria-labelledby="first-reply" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="first-reply" className="m-0 type-title">
            {PILOT_METRIC_LABEL.first_reply_time}
          </h2>
          <p className="m-0 type-caption text-ink-2">
            {targetWords('first_reply_time')} · {sampleWords('first_reply_time', metric.sample)}
          </p>
        </div>
        <StatusBadge metric={metric} />
      </div>
      <Stat
        size="xl"
        value={metricValueWords(metric)}
        label="Median, from a request to our first reply"
      />
      <DetailTable rows={firstReplyRows(metrics.firstReply)} />
      {/* S59.3.2's carried top-up (AC-X-49): email's share is visible from the first day. */}
      <div className="flex flex-col gap-1">
        <h3 className="m-0 type-label text-ink">By email vs in the app</h3>
        <DetailTable rows={channelRows(metrics.channels)} />
      </div>
    </section>
  );
}

/**
 * The pilot metrics page (S59.4, AC-X-47…49, scorecard §3): every business together over the
 * last 7 or 30 days, each number against its pilot target; first-reply time on top with email's
 * share beside it. Counts and medians only; opening it is logged (`metrics.read`).
 */
export default async function OpsMetricsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string | string[] }>;
}) {
  const days = metricsDays((await searchParams).days);
  const metrics = await currentJson(`/v1/ops/metrics?days=${String(days)}`, PilotMetricsSchema);
  const byKey = new Map(metrics?.metrics.map((metric) => [metric.key, metric]) ?? []);
  return (
    <>
      <header className="flex flex-col gap-3">
        <h1 className="m-0 type-display">Pilot metrics</h1>
        <p className="m-0 type-body text-ink-2">
          Every business together, against the pilot’s targets.
          {metrics === null
            ? null
            : ` ${String(metrics.businesses)} ${metrics.businesses === 1 ? 'business' : 'businesses'}, ${String(metrics.bookableBusinesses)} bookable.`}
        </p>
        <nav aria-label="Period">
          <ul className="m-0 flex list-none gap-1 rounded-pill bg-surface-2 p-1">
            {([7, 30] as const).map((option) => {
              const current = option === days;
              return (
                <li key={option} className="flex-1">
                  <Link
                    href={OPS_PATHS.metrics(option)}
                    aria-current={current ? 'page' : undefined}
                    className={cx(
                      'flex min-h-11 items-center justify-center rounded-pill px-4 type-label whitespace-nowrap no-underline',
                      current ? 'bg-surface text-ink shadow-raised' : 'text-ink-2 hover:text-ink',
                      FOCUS_RING,
                    )}
                  >
                    {PILOT_METRICS_PERIOD_LABEL[option]}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </header>
      {metrics === null ? (
        <p role="alert" className="m-0 rounded-md bg-warn-soft px-4 py-3 type-label text-warn">
          I couldn’t read the metrics right now. Try again in a moment.
        </p>
      ) : (
        <>
          <FirstReply metrics={metrics} />
          {PILOT_METRIC_GROUPS.map((group) => (
            <section key={group.title} aria-label={group.title} className="flex flex-col gap-1">
              <h2 className="m-0 type-title">{group.title}</h2>
              <List>
                {group.keys.map((key) => {
                  const metric = byKey.get(key);
                  return metric === undefined ? null : <MetricRow key={key} metric={metric} />;
                })}
              </List>
            </section>
          ))}
          <p className="m-0 type-caption text-ink-2">
            Times are from each sign-up, visit or request to the next step. A number from fewer than
            5 cases says “Not enough yet”. Weekly active owners and the AI’s numbers come next.
          </p>
        </>
      )}
    </>
  );
}
