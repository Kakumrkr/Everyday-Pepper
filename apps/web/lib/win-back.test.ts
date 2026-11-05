import { WinBackClientSchema, type WinBackClient } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import { ahaSentence, blockedReason, refusalText, rowMeta } from './win-back';

const NY = 'America/New_York';
const client = (overrides: Record<string, unknown> = {}): WinBackClient =>
  WinBackClientSchema.parse({
    clientId: '0199f0a4-7c1e-7d2a-9b3c-4d5e6f700011',
    name: 'Maria Lopez',
    lastVisitAt: '2026-08-29T14:00:00.000Z',
    serviceName: 'Haircut',
    staffName: 'Jess Park',
    valueCents: 4500,
    visits: 3,
    daysOverdue: 12,
    reach: 'email',
    serviceBookable: true,
    pendingProposalId: null,
    emailedAt: null,
    ...overrides,
  });

describe('the post-import line (AC-W4-8)', () => {
  it('says how many and about how much, the same numbers as the list', () => {
    expect(ahaSentence({ count: 12, totalCents: 54_000 })).toBe(
      '12 regulars are overdue, about $540',
    );
    expect(ahaSentence({ count: 1, totalCents: 4_550 })).toBe('1 regular is overdue, about $45.50');
  });

  it('leaves the dollars out when none are priced, and says nothing when no one is overdue', () => {
    expect(ahaSentence({ count: 3, totalCents: 0 })).toBe('3 regulars are overdue');
    expect(ahaSentence({ count: 0, totalCents: 0 })).toBeNull();
  });
});

describe('a row (AC-W4-6)', () => {
  it('names the service, who did it, the last visit and how late', () => {
    expect(rowMeta(client(), NY)).toBe('Haircut with Jess · last visit Aug 29 · 12 days overdue');
    expect(rowMeta(client({ staffName: null, daysOverdue: 1 }), NY)).toBe(
      'Haircut · last visit Aug 29 · 1 day overdue',
    );
    expect(rowMeta(client({ serviceName: null, daysOverdue: 0 }), NY)).toBe(
      'last visit Aug 29 · due today',
    );
  });

  it('says why it offers no draft', () => {
    expect(blockedReason(client(), NY, true)).toBeNull();
    expect(blockedReason(client({ reach: 'opted_out' }), NY, true)).toBe(
      'Unsubscribed from emails',
    );
    expect(blockedReason(client({ reach: 'no_email' }), NY, true)).toBe('No email on file');
    expect(blockedReason(client({ emailedAt: '2026-10-20T15:00:00.000Z' }), NY, true)).toBe(
      'Emailed Oct 20',
    );
    expect(blockedReason(client(), NY, false)).toBe('Add your mailing address first');
    expect(blockedReason(client({ serviceBookable: false }), NY, true)).toBe(
      'Haircut is hidden from booking',
    );
  });

  it('words every refusal', () => {
    for (const reason of [
      'not_due',
      'no_email',
      'opted_out',
      'no_address',
      'recently_emailed',
      'daily_limit',
      'no_time',
      'service_hidden',
    ] as const) {
      expect(refusalText(reason)).toMatch(/\.$/);
    }
  });
});
