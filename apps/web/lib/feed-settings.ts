import { FeedSettingsSchema, type FeedSettingsChange } from '@pepper/contracts';
import { sendJson } from './client-api';

/**
 * Saves the feed's settings (`PATCH /v1/feed/settings`: the switches, the morning hour, the
 * mailing address); `null` when it worked, else what to show. On success `refresh` runs, so the
 * server reads the feed again.
 */
export async function saveFeedSettings(
  change: FeedSettingsChange,
  refresh: () => void,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<string | null> {
  const answer = await sendJson('PATCH', '/v1/feed/settings', change, fetch);
  if (!answer.ok) return answer.message;
  if (!FeedSettingsSchema.safeParse(answer.data).success) return 'Something went wrong.';
  refresh();
  return null;
}
