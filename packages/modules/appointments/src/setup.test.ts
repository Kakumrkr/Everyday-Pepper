import { ServiceIdSchema, StaffMemberIdSchema, type WeeklyHours } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import { bookingWeek, setupWarnings } from './services/setup.js';

// The setup review's warnings (S46, AC-W1-12): from today's active services, staff and hours.

const cut = ServiceIdSchema.parse('0190c000-0000-7000-8000-000000000001');
const beard = ServiceIdSchema.parse('0190c000-0000-7000-8000-000000000002');
const ana = StaffMemberIdSchema.parse('0190c000-0000-7000-8000-0000000000a1');
const ben = StaffMemberIdSchema.parse('0190c000-0000-7000-8000-0000000000b1');
const WEEK: WeeklyHours = { intervals: [{ weekday: 2, start: '09:00', end: '18:00' }] };
const NONE: WeeklyHours = { intervals: [] };

const service = (id: typeof cut, name: string, active = true) => ({ id, name, active });
const member = (
  id: typeof ana,
  displayName: string,
  serviceIds: (typeof cut)[],
  active = true,
) => ({
  id,
  displayName,
  serviceIds,
  active,
});

describe('setupWarnings', () => {
  it('has none when every active service has someone with hours', () => {
    expect(
      setupWarnings(
        [service(cut, 'Cut'), service(beard, 'Beard')],
        [member(ana, 'Ana', [cut, beard])],
        new Map([[ana, WEEK]]),
      ),
    ).toEqual([]);
  });

  it('says there is nothing to book without an active service', () => {
    expect(setupWarnings([service(cut, 'Cut', false)], [], new Map())).toEqual([
      { kind: 'no_services' },
    ]);
  });

  it('names a staff member without hours, and the services only they offer', () => {
    expect(
      setupWarnings(
        [service(cut, 'Cut'), service(beard, 'Beard')],
        [member(ana, 'Ana', [cut]), member(ben, 'Ben', [cut, beard])],
        new Map([
          [ana, WEEK],
          [ben, NONE],
        ]),
      ),
    ).toEqual([
      { kind: 'staff_without_hours', staffMemberId: ben, displayName: 'Ben' },
      { kind: 'service_without_provider', serviceId: beard, name: 'Beard' },
    ]);
  });

  it('ignores inactive staff and services, and staff who offer nothing active', () => {
    expect(
      setupWarnings(
        [service(cut, 'Cut'), service(beard, 'Beard', false)],
        [member(ana, 'Ana', [cut]), member(ben, 'Ben', [beard]), member(ben, 'Old', [cut], false)],
        new Map([[ana, WEEK]]),
      ),
    ).toEqual([]);
  });

  it('counts an inactive provider as nobody', () => {
    expect(
      setupWarnings(
        [service(cut, 'Cut')],
        [member(ana, 'Ana', [cut], false)],
        new Map([[ana, WEEK]]),
      ),
    ).toEqual([{ kind: 'service_without_provider', serviceId: cut, name: 'Cut' }]);
  });
});

describe('bookingWeek (AC-W1-14)', () => {
  it('reads visits from the first step and bookings as done plus waitlisted', () => {
    const none = { service: 0, staff: 0, time: 0, details: 0, verify: 0, done: 0, waitlisted: 0 };
    expect(bookingWeek(none)).toEqual({ visits: 0, booked: 0 });
    expect(bookingWeek({ ...none, service: 12, details: 9, done: 6, waitlisted: 1 })).toEqual({
      visits: 12,
      booked: 7,
    });
  });
});
