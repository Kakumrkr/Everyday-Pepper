import { HealthReportSchema, type HealthReport } from '@pepper/contracts';

export type ApiHealth =
  | { reachable: true; report: HealthReport }
  | { reachable: false; reason: 'network' | 'timeout' | 'invalid-response' };

export interface FetchApiHealthOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

/**
 * Asks the api whether it is ready. A 503 still carries a valid report (dependencies down);
 * anything that is not a valid report counts as unreachable.
 */
export async function fetchApiHealth(options: FetchApiHealthOptions): Promise<ApiHealth> {
  const { baseUrl, timeoutMs = 2_000, fetch = globalThis.fetch } = options;
  let response: Response;
  try {
    response = await fetch(new URL('/health/ready', baseUrl), {
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error: unknown) {
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
    return { reachable: false, reason: timedOut ? 'timeout' : 'network' };
  }

  const body: unknown = await response.json().catch(() => undefined);
  const parsed = HealthReportSchema.safeParse(body);
  if (!parsed.success || parsed.data.service !== 'api') {
    return { reachable: false, reason: 'invalid-response' };
  }
  return { reachable: true, report: parsed.data };
}
