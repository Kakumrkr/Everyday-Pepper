import { describe, expect, it } from 'vitest';
import { isCurrent, navItems } from './nav';

describe('navItems', () => {
  it('without a business: only Home', () => {
    expect(navItems(null).map((item) => item.label)).toEqual(['Home']);
  });

  it('with a business: Calendar, Clients and Services when the role may read them, and Team', () => {
    expect(navItems(['calendar.read', 'bookings.read']).map((item) => item.href)).toEqual([
      '/',
      '/calendar',
      '/team',
    ]);
    expect(
      navItems(['calendar.read', 'clients.read', 'services.read']).map((item) => item.label),
    ).toEqual(['Home', 'Calendar', 'Clients', 'Services', 'Team']);
    expect(navItems([]).map((item) => item.label)).toEqual(['Home', 'Team']);
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
