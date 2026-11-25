import { randomBytes } from 'node:crypto';
import { GOOGLE_CALENDAR_SCOPES } from '@pepper/contracts';
import {
  CalendarProviderError,
  type AccessToken,
  type CalendarProvider,
  type ConsentUrlInput,
  type ExchangeCodeInput,
  type FreeBusyInput,
  type GrantedTokens,
} from './provider.js';

// The sandbox (S70, ADR-0069 §1): Google's flow without Google, for tests and the S70.2
// journeys. Nothing leaves the machine. Its consent page is the app's own return page, with a
// code the sandbox understands: `sandbox-ok` connects; `sandbox-expiring` connects with a refresh
// token Google would refuse at the next read (the testing-mode 7 days, in one step). Every
// connected calendar is busy one hour a day, 17:00–18:00 UTC (noon in New York in winter).

export const SANDBOX_ACCOUNT_EMAIL = 'calendar@sandbox.test';
export const SANDBOX_BUSY_HOUR_UTC = 17;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export class SandboxCalendarProvider implements CalendarProvider {
  readonly name = 'sandbox' as const;
  private readonly revoked = new Set<string>();

  constructor(
    private readonly redirectUri: string,
    private readonly now: () => number = Date.now,
  ) {}

  consentUrl(input: ConsentUrlInput): string {
    const url = new URL(this.redirectUri);
    url.searchParams.set('code', 'sandbox-ok');
    url.searchParams.set('state', input.state);
    url.searchParams.set('scope', GOOGLE_CALENDAR_SCOPES.join(' '));
    return url.toString();
  }

  exchangeCode(input: ExchangeCodeInput): Promise<GrantedTokens> {
    if (input.code !== 'sandbox-ok' && input.code !== 'sandbox-expiring') {
      return Promise.reject(new CalendarProviderError('invalid_grant', 400));
    }
    if (input.codeVerifier.length < 43) {
      return Promise.reject(new CalendarProviderError('invalid_grant', 400));
    }
    const kind = input.code === 'sandbox-expiring' ? 'expiring' : 'ok';
    return Promise.resolve({
      refreshToken: `sbx-r-${kind}-${randomBytes(12).toString('hex')}`,
      accessToken: `sbx-a-${randomBytes(12).toString('hex')}`,
      expiresAt: new Date(this.now() + HOUR_MS),
      scopes: [...GOOGLE_CALENDAR_SCOPES],
      accountEmail: SANDBOX_ACCOUNT_EMAIL,
    });
  }

  refresh(refreshToken: string): Promise<AccessToken> {
    if (!refreshToken.startsWith('sbx-r-ok-') || this.revoked.has(refreshToken)) {
      return Promise.reject(new CalendarProviderError('invalid_grant', 400));
    }
    return Promise.resolve({
      accessToken: `sbx-a-${randomBytes(12).toString('hex')}`,
      expiresAt: new Date(this.now() + HOUR_MS),
    });
  }

  freeBusy(input: FreeBusyInput): Promise<{ start: string; end: string }[]> {
    if (!input.accessToken.startsWith('sbx-a-')) {
      return Promise.reject(new CalendarProviderError('unauthorized', 401));
    }
    const busy: { start: string; end: string }[] = [];
    const firstDay = Math.floor(input.from.getTime() / DAY_MS) * DAY_MS;
    for (let day = firstDay; day < input.to.getTime(); day += DAY_MS) {
      const start = day + SANDBOX_BUSY_HOUR_UTC * HOUR_MS;
      const end = start + HOUR_MS;
      if (end > input.from.getTime() && start < input.to.getTime()) {
        busy.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString() });
      }
    }
    return Promise.resolve(busy);
  }

  revoke(token: string): Promise<void> {
    this.revoked.add(token);
    return Promise.resolve();
  }
}
