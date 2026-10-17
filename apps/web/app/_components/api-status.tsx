import { fetchApiHealth, type ApiHealth } from '../../lib/api-health';
import { loadWebServerEnv } from '../../lib/env';

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

/** Whether the api is ready (server component; rendered per request). */
export async function ApiStatus() {
  const { API_INTERNAL_URL } = loadWebServerEnv(process.env);
  const { state, text } = describe(await fetchApiHealth({ baseUrl: API_INTERNAL_URL }));
  return (
    <p className="status" data-testid="api-status" data-state={state} role="status">
      <span>API</span>
      <span>{text}</span>
    </p>
  );
}
