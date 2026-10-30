import { describe, expect, it } from 'vitest';
import { clearedDeviceCookie, deviceCookie, deviceTokenOf } from './device-cookie.js';

const TOKEN = 'a'.repeat(43);

describe('the remembered-device cookie (S47, ADR-0047)', () => {
  it('is httpOnly, Lax, scoped to the business’s api and lasts 90 days', () => {
    expect(deviceCookie('plum-salon', TOKEN as never, false)).toBe(
      `pepper_device=${TOKEN}; Path=/v1/public/businesses/plum-salon; Max-Age=7776000; HttpOnly; SameSite=Lax`,
    );
    expect(deviceCookie('plum-salon', TOKEN as never, true)).toMatch(/; Secure$/);
    expect(clearedDeviceCookie('plum-salon', true)).toBe(
      'pepper_device=; Path=/v1/public/businesses/plum-salon; Max-Age=0; HttpOnly; SameSite=Lax; Secure',
    );
  });

  it('is read only when well formed', () => {
    const read = (cookie: string | undefined) => deviceTokenOf({ headers: { cookie } });
    expect(read(`other=1; pepper_device=${TOKEN}`)).toBe(TOKEN);
    expect(read('pepper_device=short')).toBeUndefined();
    expect(read(`pepper_devices=${TOKEN}`)).toBeUndefined();
    expect(read(undefined)).toBeUndefined();
  });
});
