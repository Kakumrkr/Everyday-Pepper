import { messageFor, type CallResult } from './client-api';

// The business export's download in the browser (S51, ADR-0053, AC-W1-37): the ZIP is fetched
// from the app's own origin (forwarded to the api), then saved under the name the api gave.

export const EXPORT_PATH = '/v1/tenant/export';
const FALLBACK_NAME = 'pepper-export.zip';

/** The file name in a `content-disposition` header, if it is a plain one we can trust. */
export function fileNameOf(disposition: string | null): string {
  const match = /filename="([A-Za-z0-9._-]{1,120})"/.exec(disposition ?? '');
  return match?.[1] ?? FALLBACK_NAME;
}

/** The export as a file to save; or what went wrong, in words fit to show the owner. */
export async function fetchExport(
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<CallResult<{ file: Blob; name: string }>> {
  const offline = {
    ok: false,
    status: 0,
    message: 'The download stopped. Check your connection and try again.',
  } as const;
  let response: Response;
  try {
    response = await fetch(EXPORT_PATH, { credentials: 'same-origin' });
  } catch {
    return offline;
  }
  if (response.ok) {
    // The file comes after the headers: a connection lost on the way is said too.
    let file: Blob;
    try {
      file = await response.blob();
    } catch {
      return offline;
    }
    return {
      ok: true,
      data: { file, name: fileNameOf(response.headers.get('content-disposition')) },
    };
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (response.status === 429) {
    return {
      ok: false,
      status: 429,
      message: 'You’ve downloaded it a few times this hour. Try again in a little while.',
    };
  }
  if (response.status === 403) {
    return {
      ok: false,
      status: 403,
      message: 'Only the owner can download the business’s data.',
    };
  }
  return { ok: false, status: response.status, message: messageFor(response.status, body) };
}
