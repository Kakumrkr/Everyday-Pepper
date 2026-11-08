import type { PilotMetric, PilotMetrics } from '@pepper/contracts';
import { Badge, DetailTable, List, ListRow, Stat } from '@pepper/ui';
import {
  channelRows,
  firstReplyRows,
  metricValueWords,
  PILOT_METRIC_GROUPS,
  PILOT_METRIC_LABEL,
  PILOT_METRIC_STATUS,
  sampleWords,
  targetWords,
} from '../../../lib/pilot-metrics';

// The pilot metrics page's body (S59.4, AC-X-47…49): first-reply time with email's share beside
// it, then each group of metrics against its target. Also in the gallery, with fixed numbers.

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

/** Every metric of the page, from the api's numbers. */
export function OpsMetrics({ metrics }: { metrics: PilotMetrics }) {
  const byKey = new Map(metrics.metrics.map((metric) => [metric.key, metric]));
  return (
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
        Times are from each sign-up, visit or request to the next step. A number from fewer than 5
        cases says “Not enough yet”. Weekly active owners and the AI’s numbers come next.
      </p>
    </>
  );
}
