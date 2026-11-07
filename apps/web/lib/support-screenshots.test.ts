import { describe, expect, it, vi } from 'vitest';
import {
  discardScreenshot,
  imageFiles,
  opsScreenshotSrc,
  precheckScreenshot,
  screenshotCountLabel,
  screenshotSrc,
  uploadScreenshot,
} from './support-screenshots';

const ID = '0190a0a0-0000-7000-8000-00000000000b';

describe('precheckScreenshot (AC-X-28)', () => {
  it('lets JPEG, PNG and WebP up to 10 MB through, and a file the browser can’t name', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/webp', '']) {
      expect(precheckScreenshot({ size: 1000, type })).toBeNull();
    }
    expect(precheckScreenshot({ size: 10 * 1024 * 1024, type: 'image/png' })).toBeNull();
  });

  it('says what to do about the rest', () => {
    expect(precheckScreenshot({ size: 10 * 1024 * 1024 + 1, type: 'image/png' })).toBe(
      'That screenshot is over 10 MB. Crop it or pick a smaller one.',
    );
    expect(precheckScreenshot({ size: 10, type: 'image/heic' })).toMatch(/^HEIC screenshots/);
    expect(precheckScreenshot({ size: 10, type: 'image/gif' })).toBe(
      'Use a JPEG, PNG or WebP screenshot.',
    );
  });
});

describe('imageFiles', () => {
  it('keeps the images of a paste or a drop', () => {
    const png = new File([new Uint8Array(1)], 'a.png', { type: 'image/png' });
    const text = new File(['hi'], 'a.txt', { type: 'text/plain' });
    expect(imageFiles([png, text])).toEqual([png]);
  });
});

describe('the addresses and words (AC-X-29/30)', () => {
  it('serves members and the console on the app’s origin', () => {
    expect(screenshotSrc(ID, 'thumb')).toBe(`/v1/support/screenshots/${ID}?size=thumb`);
    expect(opsScreenshotSrc(ID, 'full')).toBe(`/v1/ops/screenshots/${ID}?size=full`);
  });

  it('counts in words', () => {
    expect(screenshotCountLabel(0)).toBeNull();
    expect(screenshotCountLabel(1)).toBe('1 screenshot');
    expect(screenshotCountLabel(2)).toBe('2 screenshots');
  });
});

describe('uploadScreenshot and discardScreenshot', () => {
  it('sends the file as itself and reads the answer', async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ id: ID, width: 800, height: 600 }), { status: 201 }),
      ),
    );
    const file = new Blob([new Uint8Array([1])], { type: 'image/png' });
    expect(await uploadScreenshot(file, fetch)).toEqual({
      ok: true,
      data: { id: ID, width: 800, height: 600 },
    });
    expect(fetch).toHaveBeenCalledWith('/v1/support/screenshots', {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: file,
      credentials: 'same-origin',
    });
  });

  it('gives a refusal’s own words, else the code’s, else offline', async () => {
    const refused = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ code: 'screenshot_rejected', message: 'Crop it to the part.' }),
          { status: 422 },
        ),
      ),
    );
    expect(await uploadScreenshot(new Blob([]), refused)).toMatchObject({
      ok: false,
      message: 'Crop it to the part.',
    });
    const limited = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ code: 'screenshot_limit_reached', message: 'x' }), {
          status: 429,
        }),
      ),
    );
    expect(await uploadScreenshot(new Blob([]), limited)).toMatchObject({
      message: 'That’s 20 screenshots today. Send what you have, or add more tomorrow.',
    });
    const offline = vi.fn(() => Promise.reject(new Error('offline')));
    expect(await uploadScreenshot(new Blob([]), offline)).toMatchObject({ status: 0 });
    const odd = vi.fn(() => Promise.resolve(new Response(JSON.stringify({}), { status: 201 })));
    expect(await uploadScreenshot(new Blob([]), odd)).toMatchObject({ ok: false });
  });

  it('removes one by its id', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    await discardScreenshot(ID, fetch);
    expect(fetch).toHaveBeenCalledWith(`/v1/support/screenshots/${ID}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
  });
});
