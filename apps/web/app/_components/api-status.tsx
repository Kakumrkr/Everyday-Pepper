import { fetchApiHealth, type ApiHealth } from '../../lib/api-health';
import { loadWebServerEnv } from '../../lib/env';

function describe(health: ApiHealth): { state: 'ok' | 'problem'; text: string } {
  if (!health.reachable) {
    return { state: 'problem', text: 'Pepper can’t be reached right now. Try again in a moment.' };
  }
  return health.report.status === 'ok'
    ? { state: 'ok', text: 'Pepper is ready.' }
    : { state: 'problem', text: 'Pepper is starting up. Try again in a moment.' };
}

/**
 * Whether the api is ready (server component; rendered per request). Said only when it isn't:
 * a sign-in screen that works needs no notice (the smoke test reads the hidden one).
 */
export async function ApiStatus() {
  const { API_INTERNAL_URL } = loadWebServerEnv(process.env);
  const { state, text } = describe(await fetchApiHealth({ baseUrl: API_INTERNAL_URL }));
  return (
    <p
      data-testid="api-status"
      data-state={state}
      role={state === 'ok' ? undefined : 'status'}
      hidden={state === 'ok'}
      className="m-0 rounded-md bg-warn-soft px-4 py-3 type-body font-semibold text-warn"
    >
      {text}
    </p>
  );
}
