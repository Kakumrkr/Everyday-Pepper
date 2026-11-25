import { describe, expect, it } from 'vitest';
import { SANDBOX_ACCOUNT_EMAIL, SandboxCalendarProvider } from './sandbox.js';

const REDIRECT = 'http://localhost:3000/more/calendar/google';
const NOW = Date.parse('2026-12-01T12:00:00Z');
const VERIFIER = 'v'.repeat(43);

describe('the sandbox', () => {
  const sandbox = new SandboxCalendarProvider(REDIRECT, () => NOW);

  it("sends the member straight back to the app's return page with a code and the state", () => {
    const url = new URL(sandbox.consentUrl({ state: 's'.repeat(43), codeChallenge: 'c' }));
    expect(`${url.origin}${url.pathname}`).toBe(REDIRECT);
    expect(url.searchParams.get('code')).toBe('sandbox-ok');
    expect(url.searchParams.get('state')).toBe('s'.repeat(43));
  });

  it('connects, refreshes and reads one busy hour a day', async () => {
    const granted = await sandbox.exchangeCode({ code: 'sandbox-ok', codeVerifier: VERIFIER });
    expect(granted.accountEmail).toBe(SANDBOX_ACCOUNT_EMAIL);
    const access = await sandbox.refresh(granted.refreshToken);
    expect(access.expiresAt).toEqual(new Date(NOW + 3_600_000));
    expect(
      await sandbox.freeBusy({
        accessToken: access.accessToken,
        from: new Date('2026-12-01T00:00:00Z'),
        to: new Date('2026-12-03T00:00:00Z'),
      }),
    ).toEqual([
      { start: '2026-12-01T17:00:00.000Z', end: '2026-12-01T18:00:00.000Z' },
      { start: '2026-12-02T17:00:00.000Z', end: '2026-12-02T18:00:00.000Z' },
    ]);
  });

  it('refuses an unknown code, a refresh token it expired, and a revoked one', async () => {
    await expect(sandbox.exchangeCode({ code: 'x', codeVerifier: VERIFIER })).rejects.toMatchObject(
      {
        code: 'invalid_grant',
      },
    );
    const expiring = await sandbox.exchangeCode({
      code: 'sandbox-expiring',
      codeVerifier: VERIFIER,
    });
    await expect(sandbox.refresh(expiring.refreshToken)).rejects.toMatchObject({
      code: 'invalid_grant',
    });
    const ok = await sandbox.exchangeCode({ code: 'sandbox-ok', codeVerifier: VERIFIER });
    await sandbox.revoke(ok.refreshToken);
    await expect(sandbox.refresh(ok.refreshToken)).rejects.toMatchObject({ code: 'invalid_grant' });
  });

  it('refuses a token it did not make', async () => {
    await expect(
      sandbox.freeBusy({ accessToken: 'ya29.real', from: new Date(NOW), to: new Date(NOW + 1) }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });
});
