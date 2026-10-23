import { MemoryFactViewSchema, type MemoryFactView, type Permission } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  aboutLine,
  canChange,
  factLabel,
  groupFacts,
  matchesFilter,
  ruleLink,
  sourceLine,
  toFactKey,
  visitLine,
} from './memory';

const CLIENT = '0199f4b2-7c1e-7a00-8000-0000000000c1';
const STAFF = '0199f4b2-7c1e-7a00-8000-0000000000d1';
const BOOKING = '0199f4b2-7c1e-7a00-8000-0000000000b1';
const TZ = 'America/New_York';
let n = 0;

function fact(overrides: Partial<z.input<typeof MemoryFactViewSchema>>): MemoryFactView {
  n += 1;
  return MemoryFactViewSchema.parse({
    id: `0199f4b2-7c1e-7a00-8000-${String(n).padStart(12, '0')}`,
    subject: { type: 'business' },
    subjectName: null,
    visit: null,
    key: 'parking',
    value: 'Behind the shop',
    sensitive: false,
    source: 'chat',
    byYou: true,
    createdAt: '2026-10-12T15:00:00.000Z',
    updatedAt: '2026-10-12T15:00:00.000Z',
    ...overrides,
  });
}

const allergy = fact({
  subject: { type: 'client', id: CLIENT },
  subjectName: 'Maria Lopez',
  key: 'allergy',
  value: 'PPD',
  sensitive: true,
});
const formula = fact({
  subject: { type: 'booking', id: BOOKING },
  subjectName: 'Maria Lopez',
  visit: { startsAt: '2026-11-02T14:00:00.000Z', serviceName: 'Full color' },
  key: 'formula',
  value: '6N + 20 vol',
  source: 'screen',
  byYou: false,
});
const jessRule = fact({
  subject: { type: 'staff', id: STAFF },
  subjectName: 'Jess',
  key: 'rule_hours_sat',
  value: 'Jess works Saturdays 10 to 4',
  source: 'ai_action',
});
const parking = fact({});

describe('"What I know" on the screen (S32)', () => {
  it('groups learned rules apart and visit notes with clients, in order', () => {
    expect(
      groupFacts([parking, allergy, jessRule, formula], 'all').map((group) => [
        group.key,
        group.facts.map((each) => each.key),
      ]),
    ).toEqual([
      ['rules', ['rule_hours_sat']],
      ['clients', ['allergy', 'formula']],
      ['business', ['parking']],
    ]);
  });

  it('filters by subject and by sensitivity', () => {
    expect(matchesFilter(formula, 'clients')).toBe(true);
    expect(matchesFilter(jessRule, 'team')).toBe(true);
    expect(matchesFilter(parking, 'clients')).toBe(false);
    expect(groupFacts([parking, allergy, formula], 'sensitive')).toEqual([
      { key: 'clients', title: 'About clients', facts: [allergy] },
    ]);
  });

  it('says where a fact came from and when, in the business’s time zone', () => {
    expect(sourceLine(allergy, TZ)).toBe('You told me in chat · Oct 12');
    expect(sourceLine(formula, TZ)).toBe('A teammate added it · Oct 12');
    expect(sourceLine(jessRule, TZ)).toBe('I saved it when you approved a change · Oct 12');
    expect(sourceLine(fact({ createdAt: '2026-10-12T02:00:00.000Z' }), TZ)).toBe(
      'You told me in chat · Oct 11',
    );
  });

  it('names whom it is about, a visit by date and service', () => {
    expect(aboutLine(allergy, TZ)).toBe('Maria Lopez');
    expect(aboutLine(formula, TZ)).toBe('Maria Lopez · visit Nov 2, Full color');
    expect(aboutLine(parking, TZ)).toBeNull();
  });

  it('labels facts and links a learned rule to its screen', () => {
    expect(factLabel('usual_service')).toBe('Usual service');
    expect(factLabel('rule_hours_sat')).toBe('Hours');
    expect(factLabel('rule_blackout_2026_12_24')).toBe('Closed days');
    expect(factLabel('rule_minimum_notice')).toBe('Minimum notice');
    expect(ruleLink(jessRule)).toBe(`/team/${STAFF}`);
    expect(ruleLink(fact({ key: 'rule_max_bookings_per_day' }))).toBe('/services/rules');
    expect(ruleLink(allergy)).toBeNull();
  });

  it('offers changes only where the role may make them (the api decides)', () => {
    // As `GET /v1/tenant` lists them for each role (the core permission matrix).
    const staff: Permission[] = ['business.read', 'client_notes.read', 'client_notes.manage'];
    const owner: Permission[] = [...staff, 'business.update', 'staff.manage', 'services.manage'];
    expect(canChange(allergy.subject, staff)).toBe(true);
    expect(canChange(parking.subject, staff)).toBe(false);
    expect(canChange(jessRule.subject, staff)).toBe(false);
    for (const each of [allergy, formula, jessRule, parking]) {
      expect(canChange(each.subject, owner)).toBe(true);
    }
  });

  it('turns a typed name into a fact key, and names a visit on the profile', () => {
    expect(toFactKey('Usual service')).toBe('usual_service');
    expect(toFactKey('  Allergy! ')).toBe('allergy');
    expect(toFactKey('2nd colour')).toBe('nd_colour');
    expect(toFactKey('!!!')).toBeNull();
    // Only a learned rule has a `rule_` key.
    expect(toFactKey('Rule hours')).toBe('rules_hours');
    expect(toFactKey('x'.repeat(60))).toHaveLength(40);
    expect(visitLine(formula, TZ)).toBe('Nov 2 · Full color');
    expect(visitLine(allergy, TZ)).toBeNull();
  });
});
