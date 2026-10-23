import type { Permission, StaffMember } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import {
  availabilityPath,
  bookableStaff,
  bookingAbilities,
  bookingActions,
  dateTimeLabel,
  instantAt,
  localParts,
  normalizeContact,
  suggestedWindow,
  timeLabel,
} from './booking';

const NY = 'America/New_York';
const AT = '2026-10-17T12:00:00.000Z';

function member(
  id: string,
  extra: { userId?: string; serviceIds?: string[]; active?: boolean } = {},
): StaffMember {
  return {
    id,
    displayName: id,
    color: '#2a7230',
    active: true,
    userId: null,
    serviceIds: [],
    createdAt: AT,
    updatedAt: AT,
    ...extra,
  } as StaffMember;
}

describe('bookingAbilities', () => {
  it('follows the permissions; only owners and managers correct outcomes', () => {
    const owner: Permission[] = [
      'bookings.manage',
      'clients.manage',
      'client_notes.read',
      'client_notes.manage',
    ];
    expect(bookingAbilities(owner, 'owner')).toEqual({
      books: true,
      managesClients: true,
      correctsOutcomes: true,
      ownStaffOnly: false,
      readsNotes: true,
      managesNotes: true,
    });
    expect(bookingAbilities(['bookings.manage', 'client_notes.read'], 'staff')).toEqual({
      books: true,
      managesClients: false,
      correctsOutcomes: false,
      ownStaffOnly: true,
      readsNotes: true,
      managesNotes: false,
    });
    expect(bookingAbilities([], 'manager').books).toBe(false);
  });
});

describe('bookableStaff', () => {
  const staff = [
    member('jess', { userId: 'u-jess', serviceIds: ['cut'] }),
    member('marco', { serviceIds: ['color'] }),
    member('gone', { active: false, serviceIds: ['cut'] }),
  ];

  it('active members, who offer the service when one is chosen', () => {
    const all = { userId: 'u-ana', ownOnly: false };
    expect(bookableStaff(staff, all).map((m) => m.id)).toEqual(['jess', 'marco']);
    expect(bookableStaff(staff, { ...all, serviceId: 'cut' }).map((m) => m.id)).toEqual(['jess']);
  });

  it('staff book only their own staff member', () => {
    expect(bookableStaff(staff, { userId: 'u-jess', ownOnly: true }).map((m) => m.id)).toEqual([
      'jess',
    ]);
    expect(bookableStaff(staff, { userId: 'u-ben', ownOnly: true })).toEqual([]);
  });
});

describe('availabilityPath', () => {
  it('asks for the business’s local day, with or without a staff member', () => {
    const date = { year: 2026, month: 11, day: 3 };
    expect(availabilityPath(NY, date, { serviceId: 's1' })).toBe(
      '/v1/availability?from=2026-11-03T05%3A00%3A00.000Z&to=2026-11-04T05%3A00%3A00.000Z&serviceId=s1',
    );
    expect(availabilityPath(NY, date, { serviceId: 's1', staffMemberId: 'j' })).toContain(
      '&staffMemberId=j',
    );
  });
});

describe('times on the business’s clock', () => {
  it('labels instants in the business’s time zone', () => {
    expect(timeLabel(NY, '2026-11-03T14:15:00.000Z')).toBe('9:15 AM');
    expect(dateTimeLabel(NY, '2026-11-03T14:15:00.000Z')).toBe('Tue, Nov 3, 9:15 AM');
  });

  it('turns a local date and time into an instant, and back', () => {
    const date = { year: 2026, month: 11, day: 3 };
    expect(instantAt(NY, date, '09:15')).toBe('2026-11-03T14:15:00.000Z');
    expect(instantAt('America/Los_Angeles', date, '09:15')).toBe('2026-11-03T17:15:00.000Z');
    expect(localParts(NY, '2026-11-03T14:15:00.000Z')).toEqual({
      date: '2026-11-03',
      time: '09:15',
    });
    expect(localParts(NY, '2026-11-04T04:30:00.000Z')).toEqual({
      date: '2026-11-03',
      time: '23:30',
    });
  });

  it.each(['9:15', '24:00', '', '09:60'])('refuses the time %j', (time) => {
    expect(instantAt(NY, { year: 2026, month: 11, day: 3 }, time)).toBeNull();
  });
});

describe('bookingActions', () => {
  const NOW = Date.parse('2026-11-03T15:00:00.000Z');
  const before = '2026-11-03T14:00:00.000Z';
  const after = '2026-11-03T16:00:00.000Z';

  it('a confirmed booking: cancel and move; done and no-show once it has started', () => {
    expect(bookingActions({ status: 'confirmed', startsAt: after }, NOW, false)).toEqual({
      complete: false,
      noShow: false,
      cancel: true,
      move: true,
    });
    expect(bookingActions({ status: 'confirmed', startsAt: before }, NOW, false)).toEqual({
      complete: true,
      noShow: true,
      cancel: true,
      move: true,
    });
  });

  it('done or no-show: final for staff, owners and managers may correct it (rule b)', () => {
    expect(bookingActions({ status: 'completed', startsAt: before }, NOW, false)).toEqual({
      complete: false,
      noShow: false,
      cancel: false,
      move: false,
    });
    expect(bookingActions({ status: 'completed', startsAt: before }, NOW, true)).toEqual({
      complete: false,
      noShow: true,
      cancel: true,
      move: false,
    });
  });

  it('a cancelled booking is final for everyone', () => {
    expect(bookingActions({ status: 'cancelled', startsAt: before }, NOW, true)).toEqual({
      complete: false,
      noShow: false,
      cancel: false,
      move: false,
    });
  });
});

describe('suggestedWindow', () => {
  it('the wanted day, from the wanted time for two hours, to midnight at most', () => {
    expect(suggestedWindow(NY, '2026-11-03T14:15:00.000Z')).toEqual({
      date: '2026-11-03',
      start: '09:15',
      end: '11:15',
    });
    expect(suggestedWindow(NY, '2026-11-04T03:30:00.000Z')).toEqual({
      date: '2026-11-03',
      start: '22:30',
      end: '24:00',
    });
  });
});

describe('normalizeContact', () => {
  it.each([
    [' Maria@Example.test ', 'Maria@Example.test'],
    ['(555) 123-4567', '+15551234567'],
    ['1 555 123 4567', '+15551234567'],
    ['+44 20 7946 0958', '+442079460958'],
    ['12345', '12345'],
  ])('%j → %j', (typed, sent) => {
    expect(normalizeContact(typed)).toBe(sent);
  });
});
