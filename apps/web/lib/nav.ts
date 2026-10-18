import type { Permission } from '@floty/contracts';
import type { IconName } from '@floty/ui';
import { ROUTES } from './account';

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
}

/**
 * The app's main places for the active business's permissions (none without a business). The
 * api checks every request; this only hides what the role cannot open.
 */
export function navItems(permissions: readonly Permission[] | null): NavItem[] {
  const items: NavItem[] = [{ href: ROUTES.home, label: 'Home', icon: 'home' }];
  if (permissions === null) return items;
  if (permissions.includes('calendar.read')) {
    items.push({ href: ROUTES.calendar, label: 'Calendar', icon: 'calendar' });
  }
  items.push({ href: ROUTES.team, label: 'Team', icon: 'team' });
  return items;
}

/** Whether `href` is the place `pathname` is in (home only on itself). */
export function isCurrent(pathname: string, href: string): boolean {
  if (href === ROUTES.home) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}
