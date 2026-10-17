import { loadWebServerEnv } from './env';
import { forwardToApi } from './forward';

/** Route handler for every method: forwards the request to the api (see `forwardToApi`). */
export function forwardRoute(request: Request): Promise<Response> {
  const { API_INTERNAL_URL } = loadWebServerEnv(process.env);
  return forwardToApi(request, { apiBaseUrl: API_INTERNAL_URL });
}
