import {
  SUPPORT_SCREENSHOT_MAX_BYTES,
  SUPPORT_SCREENSHOTS_PER_MESSAGE,
  SupportScreenshotSchema,
  type SupportScreenshot,
  type SupportScreenshotSize,
} from '@pepper/contracts';
import { messageFor, sendJson, type CallResult } from './client-api';

// Screenshots on a request in the browser (S59.2.3, ADR-0062 Part 3, AC-X-27…30): the checks
// before an upload, the upload itself, removing one before sending, and the images' addresses on
// the app's own origin (never cached: each read is checked by the api, an operator's logged).

export const ACCEPTED_SCREENSHOT_TYPES = 'image/png,image/jpeg,image/webp';
export const MAX_SCREENSHOTS = SUPPORT_SCREENSHOTS_PER_MESSAGE;

/** What's wrong with a file before it is sent, in words; `null` when it can go. */
export function precheckScreenshot(file: { size: number; type: string }): string | null {
  if (file.size > SUPPORT_SCREENSHOT_MAX_BYTES) {
    return 'That screenshot is over 10 MB. Crop it or pick a smaller one.';
  }
  if (/^image\/hei[cf]/i.test(file.type)) {
    return 'HEIC screenshots are not supported yet. Save it as a JPEG or PNG and try again.';
  }
  if (file.type !== '' && !ACCEPTED_SCREENSHOT_TYPES.split(',').includes(file.type)) {
    return 'Use a JPEG, PNG or WebP screenshot.';
  }
  return null;
}

/** The images among pasted or dropped files (a paste can carry text too). */
export function imageFiles(files: Iterable<File>): File[] {
  return [...files].filter((file) => file.type.startsWith('image/'));
}

/** Uploads one screenshot: unsent until a request or reply names its id. */
export async function uploadScreenshot(
  file: Blob,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<CallResult<SupportScreenshot>> {
  let response: Response;
  try {
    response = await fetch('/v1/support/screenshots', {
      method: 'POST',
      headers: { 'content-type': file.type === '' ? 'application/octet-stream' : file.type },
      body: file,
      credentials: 'same-origin',
    });
  } catch {
    return { ok: false, status: 0, message: 'You seem to be offline. Check your connection.' };
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    // A refused screenshot's own words say what to fix ("…too long and thin. Crop it…").
    const own =
      typeof data === 'object' &&
      data !== null &&
      'code' in data &&
      data.code === 'screenshot_rejected'
        ? (data as { message?: unknown }).message
        : undefined;
    return {
      ok: false,
      status: response.status,
      message: typeof own === 'string' ? own : messageFor(response.status, data),
      body: data,
    };
  }
  const parsed = SupportScreenshotSchema.safeParse(data);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, status: response.status, message: 'Something went wrong. Try again.' };
}

/** Removes an unsent screenshot; a failure is left to the 24 h sweep. */
export async function discardScreenshot(
  id: string,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<void> {
  await sendJson('DELETE', `/v1/support/screenshots/${encodeURIComponent(id)}`, undefined, fetch);
}

/** A screenshot's image for a member. */
export function screenshotSrc(id: string, size: SupportScreenshotSize): string {
  return `/v1/support/screenshots/${encodeURIComponent(id)}?size=${size}`;
}

/** A screenshot's image in the console (each one read is logged). */
export function opsScreenshotSrc(id: string, size: SupportScreenshotSize): string {
  return `/v1/ops/screenshots/${encodeURIComponent(id)}?size=${size}`;
}

/** "1 screenshot", "2 screenshots"; `null` for none. */
export function screenshotCountLabel(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? '1 screenshot' : `${String(count)} screenshots`;
}
