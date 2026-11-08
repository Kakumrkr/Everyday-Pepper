import { PilotMetricsSchema } from '@pepper/contracts';
import { cx, FOCUS_RING } from '@pepper/ui';
import Link from 'next/link';
import { OPS_PATHS } from '../../../lib/ops';
import { metricsDays, PILOT_METRICS_PERIOD_LABEL } from '../../../lib/pilot-metrics';
import { OpsMetrics } from '../../_components/ops/ops-metrics';
import { currentJson } from '../../_server/account';

export const dynamic = 'force-dynamic';

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
        <OpsMetrics metrics={metrics} />
      )}
    </>
  );
}
