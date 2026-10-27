import type { Permission } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import { appNav, currentKey, isCurrent, tabItems } from './nav';

const OWNER: Permission[] = [
  'calendar.read',
  'bookings.read',
  'clients.read',
  'services.read',
  'ai.chat',
  'autonomy.manage',
];

const labels = (items: readonly { label: string }[]) => items.map((item) => item.label);

describe('appNav (AC-X-5)', () => {
  it('without a business: only Home, no More', () => {
    const nav = appNav(null);
    expect(labels(nav.main)).toEqual(['Home']);
    expect(nav.pepper).toEqual([]);
    expect(nav.business).toEqual([]);
    expect(nav.more).toBeNull();
    expect(labels(tabItems(nav))).toEqual(['Home']);
  });

  it("an owner's tabs are Home · Calendar · Clients · Chat · More", () => {
    const nav = appNav(OWNER);
    expect(labels(tabItems(nav))).toEqual(['Home', 'Calendar', 'Clients', 'Chat', 'More']);
    expect(tabItems(nav).map((item) => item.href)).toEqual([
      '/',
      '/calendar',
      '/clients',
      '/chat',
      '/more',
    ]);
  });

  it('the Pepper group holds What I know, Autonomy and Waitlist; the business group Services and Team', () => {
    const nav = appNav(OWNER);
    expect(labels(nav.pepper)).toEqual(['What I know', 'Autonomy', 'Waitlist']);
    expect(nav.pepper.map((item) => item.href)).toEqual(['/memory', '/autonomy', '/waitlist']);
    expect(labels(nav.business)).toEqual(['Services', 'Team']);
  });

  it('hides what the role cannot open', () => {
    const nav = appNav(['calendar.read']);
    expect(labels(tabItems(nav))).toEqual(['Home', 'Calendar', 'More']);
    expect(labels(nav.pepper)).toEqual(['Autonomy']);
    expect(labels(nav.business)).toEqual(['Team']);
    const none = appNav([]);
    expect(labels(tabItems(none))).toEqual(['Home', 'More']);
  });

  it('never more than five tabs, so each stays a wide target at 375 px', () => {
    expect(tabItems(appNav(OWNER)).length).toBeLessThanOrEqual(5);
  });
});

describe('isCurrent', () => {
  it('matches the place and its sub-pages; Home only itself', () => {
    expect(isCurrent('/', '/')).toBe(true);
    expect(isCurrent('/calendar', '/')).toBe(false);
    expect(isCurrent('/calendar', '/calendar')).toBe(true);
    expect(isCurrent('/calendar/week', '/calendar')).toBe(true);
    expect(isCurrent('/calendars', '/calendar')).toBe(false);
  });
});

describe('currentKey', () => {
  const nav = appNav(OWNER);

  it('a tab lights itself in both bars', () => {
    expect(currentKey(nav, '/', true)).toBe('home');
    expect(currentKey(nav, '/clients/abc', true)).toBe('clients');
    expect(currentKey(nav, '/chat', false)).toBe('chat');
  });

  it('a place outside the tabs lights More on phones and itself in the sidebar', () => {
    expect(currentKey(nav, '/waitlist', true)).toBe('more');
    expect(currentKey(nav, '/waitlist', false)).toBe('waitlist');
    expect(currentKey(nav, '/services/rules', true)).toBe('more');
    expect(currentKey(nav, '/services/rules', false)).toBe('services');
  });

  it('More lights itself; unknown pages light nothing', () => {
    expect(currentKey(nav, '/more', true)).toBe('more');
    expect(currentKey(nav, '/more', false)).toBe('more');
    expect(currentKey(nav, '/security/two-factor', true)).toBeNull();
  });
});
