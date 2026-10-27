import { describe, expect, it, vi } from 'vitest';
import { saveFeedSettings } from './feed-settings';

const SETTINGS = { suggestionsPaused: false, disabledKinds: [], morningHour: null };
const ADDRESS = '12 Main St\nPortland, OR 97201';

function answering(status: number, body: unknown) {
  return vi.fn<typeof fetch>(() => Promise.resolve(Response.json(body, { status })));
}

describe('saveFeedSettings', () => {
  it('PATCHes the change and refreshes the page when the settings come back', async () => {
    const fetch = answering(200, SETTINGS);
    const refresh = vi.fn();
    await expect(saveFeedSettings({ mailingAddress: ADDRESS }, refresh, fetch)).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledWith(
      '/v1/feed/settings',
      expect.objectContaining({ method: 'PATCH' }),
    );
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('says why when the api refuses, and does not refresh', async () => {
    const refresh = vi.fn();
    const message = await saveFeedSettings(
      { suggestionsPaused: true },
      refresh,
      answering(403, { code: 'forbidden', message: 'x' }),
    );
    expect(message).toContain('doesn’t allow this');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refuses an answer that is not the settings', async () => {
    const refresh = vi.fn();
    await expect(
      saveFeedSettings({ suggestionsPaused: true }, refresh, answering(200, { nope: 1 })),
    ).resolves.toBe('Something went wrong.');
    expect(refresh).not.toHaveBeenCalled();
  });
});
