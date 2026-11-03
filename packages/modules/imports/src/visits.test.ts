import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { suggestMapping, mappingOf } from './mapping.js';
import { parseImportFile, type Table } from './parse.js';
import { mapRows, type RawVisit } from './rows.js';
import { planVisits, visitTimes, type VisitContext, type VisitEntry } from './visits.js';

// The visit planner (S49, ADR-0050, AC-W1-22…24), without a database.

const NOW = Date.parse('2026-11-03T15:00:00Z');
const ZONE = 'America/New_York';

const context: VisitContext = {
  timeZone: ZONE,
  services: [
    {
      id: 'svc-cut',
      name: 'Haircut',
      durationMinutes: 45,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 15,
      priceFromCents: 4500,
    },
  ],
  staff: [
    { id: 'st-dre', name: 'Dre Mason' },
    { id: 'st-kai', name: 'Kai' },
  ],
  defaultStaff: { id: 'st-dre', name: 'Dre Mason' },
};

function visit(overrides: Partial<RawVisit> = {}): RawVisit {
  return {
    date: { date: { year: 2026, month: 3, day: 2 }, minute: 600, offset: null },
    time: null,
    end: null,
    duration: null,
    service: 'Haircut',
    staff: 'Dre',
    priceCents: null,
    status: 'kept',
    visitId: null,
    ...overrides,
  };
}

const entry = (row: number, v: RawVisit, clientKey = 'client-1'): VisitEntry => ({
  row,
  visit: v,
  clientKey,
});

const plan = (
  entries: VisitEntry[],
  options: Partial<Parameters<typeof planVisits>[3]> = {},
  ctx: VisitContext = context,
) => planVisits('csv', entries, ctx, { now: NOW, busy: [], existing: new Set(), ...options });

const upcoming = (minute = 600) =>
  visit({ date: { date: { year: 2027, month: 1, day: 12 }, minute, offset: null } });

describe('visitTimes (AC-W1-22)', () => {
  it('reads a time without an offset in the business’s zone, and one with an offset as is', () => {
    expect(visitTimes(visit(), ZONE)?.start).toBe(Date.parse('2026-03-02T15:00:00Z'));
    // Summer time: 10:00 in New York is 14:00 UTC.
    const july = visit({
      date: { date: { year: 2026, month: 7, day: 1 }, minute: 600, offset: null },
    });
    expect(visitTimes(july, ZONE)?.start).toBe(Date.parse('2026-07-01T14:00:00Z'));
    const fixed = visit({
      date: { date: { year: 2026, month: 3, day: 2 }, minute: 600, offset: 60 },
    });
    expect(visitTimes(fixed, ZONE)?.start).toBe(Date.parse('2026-03-02T09:00:00Z'));
  });

  it('takes a separate time column over the date’s, and an end on the same day', () => {
    const times = visitTimes(
      visit({
        date: { date: { year: 2026, month: 3, day: 2 }, minute: null, offset: null },
        time: 870,
        end: { date: { year: 2026, month: 3, day: 2 }, minute: 915, offset: null },
      }),
      ZONE,
    );
    expect(times).toEqual({
      start: Date.parse('2026-03-02T19:30:00Z'),
      end: Date.parse('2026-03-02T20:15:00Z'),
    });
  });
});

describe('planVisits (AC-W1-22…24)', () => {
  it('makes past rows completed or no-show and later rows confirmed', () => {
    const { visits } = plan([
      entry(2, visit()),
      entry(3, visit({ status: 'no_show', date: { ...visit().date, minute: 700 } })),
      entry(4, upcoming()),
    ]);
    expect(visits.map((v) => [v.outcome, v.status])).toEqual([
      ['create', 'completed'],
      ['create', 'no_show'],
      ['create', 'confirmed'],
    ]);
  });

  it('finds the service by name ignoring case and spaces, with its length, buffers and price', () => {
    const [cut] = plan([entry(2, visit({ service: '  haircut ' }))]).visits;
    expect(cut).toMatchObject({
      serviceId: 'svc-cut',
      serviceName: 'Haircut',
      durationMinutes: 45,
      bufferAfterMinutes: 15,
      priceCents: 4500,
    });
  });

  it('brings an unknown service in as a hidden one, with its rows’ most common length', () => {
    const { visits, summary } = plan([
      entry(2, visit({ service: 'Fade Deluxe', duration: 50 })),
      entry(
        3,
        visit({ service: 'fade deluxe', duration: 50, date: { ...visit().date, minute: 700 } }),
      ),
      entry(
        4,
        visit({ service: 'Fade Deluxe', duration: 30, date: { ...visit().date, minute: 800 } }),
      ),
      entry(5, visit({ service: null, date: { ...visit().date, minute: 900 } })),
    ]);
    expect(visits.map((v) => [v.serviceId, v.serviceName, v.durationMinutes])).toEqual([
      [null, 'Fade Deluxe', 50],
      [null, 'Fade Deluxe', 50],
      [null, 'Fade Deluxe', 30],
      [null, 'Imported visit', 60],
    ]);
    expect(summary.newServices).toEqual([
      { key: 'fade deluxe', name: 'Fade Deluxe', durationMinutes: 50 },
      { key: 'imported visit', name: 'Imported visit', durationMinutes: 60 },
    ]);
    expect(summary.notices).toContain(
      '“Fade Deluxe” isn’t one of your services: 3 visits bring it in as a hidden service of 50 minutes.',
    );
  });

  it('finds staff by name or a unique first name, and sends the rest to the default', () => {
    const { visits, summary } = plan([
      entry(2, visit({ staff: 'dre mason' })),
      entry(3, visit({ staff: 'Dre', date: { ...visit().date, minute: 700 } })),
      entry(4, visit({ staff: 'Kai Lee', date: { ...visit().date, minute: 800 } })),
      entry(5, visit({ staff: 'Jo', date: { ...visit().date, minute: 900 } })),
      entry(6, visit({ staff: null, date: { ...visit().date, minute: 1000 } })),
    ]);
    expect(visits.map((v) => v.staffId)).toEqual([
      'st-dre',
      'st-dre',
      'st-kai',
      'st-dre',
      'st-dre',
    ]);
    expect(summary.notices).toEqual([
      '“Jo” isn’t on your team: 1 visit goes to Dre Mason.',
      '1 visit doesn’t say who it was with, so it goes to Dre Mason.',
    ]);
  });

  it('stops the import when nobody can take the visits', () => {
    const { summary } = plan(
      [entry(2, visit({ staff: 'Jo' }))],
      {},
      {
        ...context,
        staff: [],
        defaultStaff: null,
      },
    );
    expect(summary.problems).toEqual([
      'Add yourself to your team first: every visit needs someone it was with.',
    ]);
  });

  it('skips cancelled rows and repeats, and leaves visits Pepper has unchanged', () => {
    const start = Date.parse('2026-03-02T15:00:00Z');
    const { visits } = plan(
      [
        entry(2, visit({ status: 'cancelled' })),
        entry(3, visit(), 'client-2'),
        entry(4, visit(), 'client-2'),
        entry(5, visit(), 'client-3'),
      ],
      { existing: new Set([`client-3|${String(start)}`]) },
    );
    expect(visits.map((v) => [v.outcome, v.reasons[0]?.code])).toEqual([
      ['skipped', 'cancelled'],
      ['create', undefined],
      ['skipped', 'visit_duplicate'],
      ['unchanged', 'visit_exists'],
    ]);
    expect(visits[2]?.reasons[0]?.message).toBe('Row 4: the same visit as row 3, so it’s skipped.');
  });

  it('lists an upcoming time another booking holds as a conflict, buffers included', () => {
    const start = Date.parse('2027-01-12T15:00:00Z');
    const { visits } = plan([entry(2, upcoming()), entry(3, upcoming(), 'client-2')], {
      busy: [
        // Ends at 10:00 sharp: no overlap.
        { staffMemberId: 'st-dre', from: new Date(start - 3_600_000), to: new Date(start) },
      ],
    });
    expect(visits.map((v) => v.outcome)).toEqual(['create', 'conflict']);
    expect(visits[1]?.reasons[0]?.message).toBe(
      'Row 3: Dre Mason already has a booking at Jan 12, 10:00 AM, so this one is left out. Book it again from the calendar if it still stands.',
    );
    // The haircut's 15 minutes after reach into a booking at 10:50.
    const after = plan([entry(2, upcoming())], {
      busy: [
        {
          staffMemberId: 'st-dre',
          from: new Date(start + 50 * 60_000),
          to: new Date(start + 80 * 60_000),
        },
      ],
    });
    expect(after.visits[0]?.outcome).toBe('conflict');
  });

  it('never checks history against the calendar', () => {
    const start = Date.parse('2026-03-02T15:00:00Z');
    const { visits } = plan([entry(2, visit()), entry(3, visit(), 'client-2')], {
      busy: [{ staffMemberId: 'st-dre', from: new Date(start), to: new Date(start + 3_600_000) }],
    });
    expect(visits.map((v) => v.outcome)).toEqual(['create', 'create']);
  });

  it('refuses an end before the start', () => {
    const [bad] = plan([
      entry(
        2,
        visit({ end: { date: { year: 2026, month: 3, day: 2 }, minute: 540, offset: null } }),
      ),
    ]).visits;
    expect(bad?.outcome).toBe('invalid');
    expect(bad?.reasons[0]?.code).toBe('duration_invalid');
  });
});

describe('each tool’s appointments export (AC-W1-22)', () => {
  const read = (name: string): Table =>
    parseImportFile(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

  it.each([
    ['square-appointments.csv', 'square', 5],
    ['booksy-appointments.csv', 'booksy', 3],
    ['vagaro-appointments.csv', 'vagaro', 3],
    ['glossgenius-appointments.csv', 'glossgenius', 3],
    ['fresha-appointments.csv', 'fresha', 3],
    ['visits.csv', null, 5],
  ])('%s reads every row as a visit', (name, preset, rows) => {
    const table = read(name);
    const suggested = suggestMapping(table);
    expect(suggested.preset).toBe(preset);
    const mapped = mapRows(table, mappingOf(suggested.columns));
    expect(mapped).toHaveLength(rows);
    for (const row of mapped) {
      expect(row.reasons).toEqual([]);
      expect(row.visit).not.toBeNull();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- checked just above
      expect(visitTimes(row.visit!, ZONE)).not.toBeNull();
    }
  });

  it('reads Square’s statuses, lengths and prices', () => {
    const table = read('square-appointments.csv');
    const mapped = mapRows(table, mappingOf(suggestMapping(table).columns));
    expect(
      mapped.map((row) => [row.visit?.status, row.visit?.duration, row.visit?.priceCents]),
    ).toEqual([
      ['kept', 45, 4500],
      ['kept', 45, 4500],
      ['no_show', 30, 2500],
      ['cancelled', 60, 9000],
      ['kept', 45, 4500],
    ]);
    const { visits } = planVisits(
      'csv',
      mapped.flatMap((row, i) =>
        row.visit === null ? [] : [{ row: row.row, visit: row.visit, clientKey: `c${String(i)}` }],
      ),
      {
        ...context,
        staff: [{ id: 'st-dre', name: 'Dre' }],
        defaultStaff: { id: 'st-dre', name: 'Dre' },
      },
      { now: NOW, busy: [], existing: new Set() },
    );
    expect(visits.map((v) => [v.outcome, v.status])).toEqual([
      ['create', 'completed'],
      ['create', 'completed'],
      ['create', 'no_show'],
      ['skipped', 'completed'],
      ['create', 'confirmed'],
    ]);
  });
});
