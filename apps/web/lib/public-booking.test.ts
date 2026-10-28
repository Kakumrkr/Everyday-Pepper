import { describe, expect, it } from 'vitest';
import {
  checkDetails,
  confirmProblem,
  initials,
  localTimeLabel,
  managePath,
  publicApiPath,
  publicAvailabilityPath,
  offerStateText,
  readManageToken,
  readOfferToken,
  refusedClaimStatus,
  serviceOf,
  staffFor,
  upcomingDays,
} from './public-booking';

const TOKEN = 'q1W2e3R4t5Y6u7I8o9P0a_S-d1F2g3H4j5K6l7Z8x9C';
const BUSINESS = {
  services: [
    {
      id: 's1',
      name: 'Cut',
      category: null,
      durationMinutes: 45,
      priceFromCents: 6500,
      priceToCents: null,
    },
  ],
  staff: [
    { id: 'a', displayName: 'Jess', color: '#2a7230', serviceIds: ['s1'] },
    { id: 'b', displayName: 'Marco', color: '#1d65a8', serviceIds: [] },
  ],
} as never;

describe('paths', () => {
  it('builds the api paths of a page', () => {
    expect(publicApiPath('juniper')).toBe('/v1/public/businesses/juniper');
    expect(publicApiPath('juniper', '/booking/cancel')).toBe(
      '/v1/public/businesses/juniper/booking/cancel',
    );
  });

  it('asks for one local day, with or without a staff member', () => {
    const date = { year: 2026, month: 11, day: 3 };
    expect(
      publicAvailabilityPath('juniper', 'America/New_York', date, {
        serviceId: 's1',
        staffMemberId: null,
      }),
    ).toBe(
      '/v1/public/businesses/juniper/availability?from=2026-11-03T05%3A00%3A00.000Z&to=2026-11-04T05%3A00%3A00.000Z&serviceId=s1',
    );
    expect(
      publicAvailabilityPath('juniper', 'America/New_York', date, {
        serviceId: 's1',
        staffMemberId: 'a',
      }),
    ).toContain('&staffMemberId=a');
  });

  it('puts the link secret in the fragment only', () => {
    expect(managePath('juniper', TOKEN)).toBe(`/book/juniper/manage#${TOKEN}`);
  });
});

describe('upcomingDays', () => {
  it("starts today on the business's clock", () => {
    // 03:00 UTC on 3 November is still 2 November in New York.
    const days = upcomingDays('America/New_York', Date.parse('2026-11-03T03:00:00Z'), 3);
    expect(days).toEqual([
      { date: '2026-11-02', weekday: 'Mon', day: 2, month: 'Nov', label: 'Monday, November 2' },
      { date: '2026-11-03', weekday: 'Tue', day: 3, month: 'Nov', label: 'Tuesday, November 3' },
      { date: '2026-11-04', weekday: 'Wed', day: 4, month: 'Nov', label: 'Wednesday, November 4' },
    ]);
    expect(upcomingDays('UTC', 0)).toHaveLength(14);
  });
});

describe('the page data', () => {
  it('finds a service and who offers it', () => {
    expect(serviceOf(BUSINESS, 's1')?.name).toBe('Cut');
    expect(serviceOf(BUSINESS, null)).toBeUndefined();
    expect(staffFor(BUSINESS, 's1').map((s) => s.displayName)).toEqual(['Jess']);
  });

  it('names the business clock by its city, never by its zone id', () => {
    expect(localTimeLabel('America/Chicago')).toBe('Chicago time');
    expect(localTimeLabel('America/Los_Angeles')).toBe('Los Angeles time');
    expect(localTimeLabel('America/Argentina/Buenos_Aires')).toBe('Buenos Aires time');
    expect(localTimeLabel('UTC')).toBe('UTC');
    expect(localTimeLabel('Etc/UTC')).toBe('UTC');
  });

  it('makes initials of a business name', () => {
    expect(initials('Juniper Hair Studio')).toBe('JH');
    expect(initials('  plum ')).toBe('P');
    expect(initials('& Co')).toBe('C');
  });
});

describe('checkDetails', () => {
  it('trims, and turns a local US phone into E.164', () => {
    expect(
      checkDetails({ name: ' Ana Ruiz ', email: ' ana@example.test ', phone: '(555) 123-4567' }),
    ).toEqual({
      ok: true,
      details: { name: 'Ana Ruiz', email: 'ana@example.test', phone: '+15551234567' },
    });
    expect(checkDetails({ name: 'Ana', email: 'ana@example.test', phone: '' })).toMatchObject({
      ok: true,
      details: { phone: null },
    });
  });

  it('names each field to fix', () => {
    expect(checkDetails({ name: ' ', email: 'ana@', phone: '12' })).toEqual({
      ok: false,
      errors: {
        name: 'Enter your name so the business knows who’s coming.',
        email: 'Enter a valid email. We’ll send your code there.',
        phone: 'Enter a phone number like (555) 123-4567, or leave it empty.',
      },
    });
  });
});

describe('readManageToken', () => {
  it('reads the secret from the fragment, or nothing for a broken link', () => {
    expect(readManageToken(`#${TOKEN}`)).toBe(TOKEN);
    expect(readManageToken(TOKEN)).toBe(TOKEN);
    expect(readManageToken('#short')).toBeNull();
    expect(readManageToken('')).toBeNull();
  });
});

describe('confirmProblem', () => {
  it.each([
    [422, { code: 'wrong_code', attemptsLeft: 2 }, 'wrong_code'],
    [410, { code: 'booking_request_expired' }, 'expired'],
    [404, { code: 'booking_request_not_found' }, 'expired'],
    [409, { code: 'booking_request_used' }, 'used'],
    [409, { code: 'slot_unavailable', alternatives: [] }, 'taken'],
    [500, null, 'other'],
    [429, 'Too many', 'other'],
  ])('%d %j → %s', (status, body, problem) => {
    expect(confirmProblem(status, body)).toBe(problem);
  });
});

describe('waitlist offers (S37)', () => {
  it('reads the claim secret from the fragment, or nothing for a broken link', () => {
    expect(readOfferToken(`#${TOKEN}`)).toBe(TOKEN);
    expect(readOfferToken('#short')).toBeNull();
    expect(readOfferToken('')).toBeNull();
  });

  it('explains every state but an open one, never naming who has the time', () => {
    expect(offerStateText('open')).toBeNull();
    for (const status of ['claimed', 'taken', 'expired'] as const) {
      expect(offerStateText(status)).toMatch(/\w/);
    }
    expect(offerStateText('taken')).toContain('still on the waitlist');
  });
});

describe('refusedClaimStatus (S37)', () => {
  const refused = (status: number, code: string) => ({
    ok: false as const,
    status,
    message: 'x',
    body: { code, message: 'x' },
  });

  it('reads a refused claim as the offer it now is', () => {
    expect(refusedClaimStatus(refused(409, 'waitlist_offer_taken'))).toBe('taken');
    expect(refusedClaimStatus(refused(409, 'waitlist_offer_used'))).toBe('claimed');
    expect(refusedClaimStatus(refused(410, 'waitlist_offer_expired'))).toBe('expired');
  });

  it('leaves anything else to "try again"', () => {
    expect(refusedClaimStatus(refused(429, 'too_many_requests'))).toBeNull();
    expect(refusedClaimStatus({ ok: true, data: {} })).toBeNull();
  });
});
