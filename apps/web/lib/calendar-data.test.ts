import {
  UserIdSchema,
  type Booking,
  type BusyTime,
  type Service,
  type StaffMember,
} from '@pepper/contracts';
import { describe, expect, it, vi } from 'vitest';
import { loadCalendarDay, MAX_CLIENT_LOOKUPS, seesDetailsOf, visitClient } from './calendar-data';

const T = '2026-11-03T15:00:00.000Z';
const id = (n: number) => `0199f0a4-7c1e-7d2a-9b3c-${String(n).padStart(12, '0')}`;
const STAFF: StaffMember = {
  id: id(1),
  displayName: 'Jess',
  color: '#2a7230',
  active: true,
  userId: id(9),
  serviceIds: [id(2)],
  createdAt: T,
  updatedAt: T,
} as StaffMember;
const SERVICE = {
  id: id(2),
  name: 'Haircut',
  category: null,
  durationMinutes: 60,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  priceFromCents: null,
  priceToCents: null,
  active: true,
  createdAt: T,
  updatedAt: T,
} as Service;
function booking(n: number, clientId: string, status: Booking['status'] = 'confirmed'): Booking {
  return {
    id: id(100 + n),
    clientId,
    serviceId: SERVICE.id,
    staffMemberId: STAFF.id,
    startsAt: T,
    endsAt: '2026-11-03T16:00:00.000Z',
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    priceFromCents: null,
    priceToCents: null,
    status,
    source: 'team',
    overridden: false,
    createdAt: T,
    updatedAt: T,
  } as Booking;
}
const BUSY = {
  staffMemberId: STAFF.id,
  startsAt: T,
  endsAt: '2026-11-03T16:00:00.000Z',
  occupiedFrom: T,
  occupiedTo: '2026-11-03T16:00:00.000Z',
} as BusyTime;
/** The api's names: "Client NNN" by the id's last digits; a 9xx id was deleted. */
const nameOf = (clientId: string) =>
  clientId.endsWith('999')
    ? { id: clientId, name: 'Deleted client', deleted: true }
    : { id: clientId, name: `Client ${clientId.slice(-3)}`, deleted: false };

const range = { from: '2026-11-03T05:00:00.000Z', to: '2026-11-04T05:00:00.000Z' };

function api(answers: Record<string, unknown>, failing: string[] = []) {
  const paths: string[] = [];
  const fetch = vi.fn((url: URL) => {
    const path = url.pathname;
    paths.push(`${path}${url.search}`);
    if (failing.includes(path)) return Promise.resolve(new Response('no', { status: 500 }));
    const body =
      path === '/v1/clients/names'
        ? { names: (url.searchParams.get('ids') ?? '').split(',').map(nameOf) }
        : answers[path];
    return Promise.resolve(Response.json(body));
  });
  return {
    options: {
      baseUrl: 'http://api:4000',
      cookie: 'c',
      fetch: fetch as unknown as typeof globalThis.fetch,
    },
    paths,
  };
}

const full = (bookings: Booking[], truncated = false) => ({
  '/v1/staff': { staff: [STAFF] },
  '/v1/services': { services: [SERVICE] },
  '/v1/bookings': { bookings, truncated },
  '/v1/calendar/busy': { busy: [BUSY], truncated: false },
});

describe('loadCalendarDay', () => {
  it("loads the day's data and the names of its clients, leaving out cancelled bookings", async () => {
    const { options, paths } = api(
      full([
        booking(1, id(50)),
        booking(2, id(50)),
        booking(3, id(51), 'cancelled'),
        booking(4, id(999)),
      ]),
    );
    const day = await loadCalendarDay(options, range);
    expect(day.staff).toEqual([STAFF]);
    expect(day.services).toEqual([SERVICE]);
    expect(day.bookings.map((b) => b.id)).toEqual([id(101), id(102), id(104)]);
    expect(day.busy).toEqual([BUSY]);
    expect([...day.clientNames]).toEqual([
      [id(50), { name: 'Client 050', deleted: false }],
      [id(999), { name: 'Deleted client', deleted: true }],
    ]);
    expect([day.truncated, day.failed]).toEqual([false, false]);
    const query = new URLSearchParams(range).toString();
    expect(paths).toEqual(
      expect.arrayContaining([`/v1/bookings?${query}`, `/v1/calendar/busy?${query}`]),
    );
    // One request for every client's name, each client once (S50.2).
    expect(paths.filter((p) => p.startsWith('/v1/clients'))).toEqual([
      `/v1/clients/names?ids=${id(50)},${id(999)}`,
    ]);
  });

  it(`looks up at most ${String(MAX_CLIENT_LOOKUPS)} clients, and none for an empty day`, async () => {
    const many = Array.from({ length: MAX_CLIENT_LOOKUPS + 5 }, (_, n) => booking(n, id(1000 + n)));
    const { options, paths } = api(full(many, true));
    const day = await loadCalendarDay(options, range);
    expect(paths.filter((p) => p.startsWith('/v1/clients'))).toHaveLength(1);
    expect(day.clientNames.size).toBe(MAX_CLIENT_LOOKUPS);
    expect(day.truncated).toBe(true);
    const empty = api(full([]));
    await loadCalendarDay(empty.options, range);
    expect(empty.paths.filter((p) => p.startsWith('/v1/clients'))).toEqual([]);
  });

  it('marks the view as failed when an answer is missing', async () => {
    const { options } = api(full([]), ['/v1/bookings']);
    const day = await loadCalendarDay(options, range);
    expect(day.failed).toBe(true);
    expect(day.bookings).toEqual([]);
    expect(day.staff).toEqual([STAFF]);
  });
});

describe('seesDetailsOf', () => {
  it('owners and managers see everyone; staff only their own staff member', () => {
    const user = (n: number) => UserIdSchema.parse(id(n));
    expect(seesDetailsOf('owner', id(9), { userId: null })).toBe(true);
    expect(seesDetailsOf('manager', id(8), { userId: user(9) })).toBe(true);
    expect(seesDetailsOf('staff', id(9), { userId: user(9) })).toBe(true);
    expect(seesDetailsOf('staff', id(8), { userId: user(9) })).toBe(false);
    expect(seesDetailsOf('staff', id(8), { userId: null })).toBe(false);
  });
});

describe('visitClient (AC-W1-36)', () => {
  it('names the client with their profile; a deleted one without; an unknown one as "Client"', () => {
    expect(visitClient({ name: 'Maria', deleted: false }, id(5))).toEqual({
      client: 'Maria',
      clientId: id(5),
    });
    expect(visitClient({ name: 'Deleted client', deleted: true }, id(5))).toEqual({
      client: 'Deleted client',
      clientId: null,
    });
    expect(visitClient(undefined, id(5))).toEqual({ client: 'Client', clientId: null });
  });
});
