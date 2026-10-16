import { fetchApiHealth, type ApiHealth } from '../lib/api-health';
import { loadWebServerEnv } from '../lib/env';

// Rendered per request: the status must be live, and env is read at runtime, not build time.
export const dynamic = 'force-dynamic';

const reasons = {
  network: 'not reachable',
  timeout: 'not answering',
  'invalid-response': 'answering unexpectedly',
} as const;

function describe(health: ApiHealth): { state: 'ok' | 'problem'; text: string } {
  if (!health.reachable) return { state: 'problem', text: reasons[health.reason] };
  return health.report.status === 'ok'
    ? { state: 'ok', text: 'ready' }
    : { state: 'problem', text: 'starting up' };
}

/** Phase 1 placeholder: proves web → api wiring. The real home (operator feed) comes in Phase 4. */
export default async function HomePage() {
  const { API_INTERNAL_URL } = loadWebServerEnv(process.env);
  const { state, text } = describe(await fetchApiHealth({ baseUrl: API_INTERNAL_URL }));

  return (
    <main>
      <h1 className="wordmark">floty</h1>
      <p className="tagline">Your AI employee is getting ready.</p>
      <p className="status" data-testid="api-status" data-state={state} role="status">
        <span>API</span>
        <span>{text}</span>
      </p>
    </main>
  );
}
