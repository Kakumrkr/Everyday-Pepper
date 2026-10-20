/** Request headers passed on to the api; everything else (e.g. `authorization`) is dropped. */
const REQUEST_HEADERS = [
  'accept',
  'content-type',
  'cookie',
  // Better Auth and the api check these against the app origin (CSRF).
  'origin',
  'referer',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'user-agent',
  // Client address for rate limits. In front of the pilot an edge proxy must overwrite it.
  'x-forwarded-for',
  'x-request-id',
] as const;

/** Response headers passed back to the browser. */
const RESPONSE_HEADERS = [
  'cache-control',
  'content-type',
  'location',
  'retry-after',
  'x-request-id',
] as const;

/** Largest body forwarded; the api's JSON parser accepts no more (Express default, 100 KB). */
export const MAX_BODY_BYTES = 100 * 1024;

const TOO_LARGE = { code: 'payload_too_large', message: 'That request is too large.' };

export interface ForwardOptions {
  /** Base URL of the api as seen from the web server (`API_INTERNAL_URL`). */
  apiBaseUrl: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

/**
 * Forwards a browser request for `/api/auth/*` or `/v1/*` to the api, so the browser talks to
 * one origin: cookies stay first-party and no CORS is needed (ADR-0012). Only listed headers
 * pass in either direction; every `Set-Cookie` is kept. The api stays the only place that
 * decides anything.
 */
export async function forwardToApi(request: Request, options: ForwardOptions): Promise<Response> {
  const { apiBaseUrl, timeoutMs = 10_000, fetch = globalThis.fetch } = options;
  const incoming = new URL(request.url);
  const target = new URL(incoming.pathname + incoming.search, apiBaseUrl);

  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  // Checked before and after reading, so a missing or false Content-Length cannot get past it.
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
    return Response.json(TOO_LARGE, { status: 413 });
  }
  const body = hasBody ? await request.arrayBuffer() : undefined;
  if (body !== undefined && body.byteLength > MAX_BODY_BYTES) {
    return Response.json(TOO_LARGE, { status: 413 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      ...(body !== undefined && { body }),
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return Response.json(
      { code: 'api_unavailable', message: 'Pepper is not reachable right now. Try again soon.' },
      { status: 502 },
    );
  }

  const responseHeaders = new Headers();
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) responseHeaders.set(name, value);
  }
  // Answers hold a business's data and people's details: a shared front-desk device must not
  // keep them in its disk cache (S18 security review). The api may still opt in to caching.
  if (!responseHeaders.has('cache-control')) {
    responseHeaders.set('cache-control', 'private, no-store');
  }
  for (const cookie of upstream.headers.getSetCookie()) {
    responseHeaders.append('set-cookie', cookie);
  }
  // The body is already decoded by fetch, so length and encoding headers are not copied.
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}
