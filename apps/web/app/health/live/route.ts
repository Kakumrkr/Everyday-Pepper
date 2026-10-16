import { HealthReportSchema, type HealthReport } from '@floty/contracts';

export const dynamic = 'force-dynamic';

/** The web server is up. Used by the Compose healthcheck; does not call the api. */
export function GET(): Response {
  const report: HealthReport = HealthReportSchema.parse({
    service: 'web',
    status: 'ok',
    checks: {},
    checkedAt: new Date().toISOString(),
  });
  return Response.json(report, { headers: { 'Cache-Control': 'no-store' } });
}
