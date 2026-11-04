import type { Permission } from '@pepper/contracts';
import type { IconName } from '@pepper/ui';
import { ROUTES } from './account';

export interface NavItem {
  key: string;
  href: string;
  label: string;
  icon: IconName;
}

/** The app's places for one role, grouped as the shell shows them (S41, AC-X-5). */
export interface Nav {
  /** The everyday places: the phone's tabs before More, the top of the desktop sidebar. */
  main: NavItem[];
  /** Pepper's own places: what it knows, how much it does alone, the waitlist it works. */
  pepper: NavItem[];
  /** How the business is set up. */
  business: NavItem[];
  /** Settings and account; the phone's More tab lists the groups above it too. */
  more: NavItem | null;
}

/** The phone's last tab; on desktop the same page is "Settings" at the sidebar's foot. */
export const MORE_HREF = '/more';

/**
 * The app's places for the active business's permissions (none without a business). The api
 * checks every request; this only hides what the role cannot open.
 */
export function appNav(permissions: readonly Permission[] | null): Nav {
  const main: NavItem[] = [{ key: 'home', href: ROUTES.home, label: 'Home', icon: 'home' }];
  if (permissions === null) return { main, pepper: [], business: [], more: null };
  const can = (permission: Permission) => permissions.includes(permission);
  // Cards first, chat second (ADR-0043): Chat sits after the places owners open every day.
  if (can('calendar.read')) {
    main.push({ key: 'calendar', href: ROUTES.calendar, label: 'Calendar', icon: 'calendar' });
  }
  if (can('clients.read')) {
    main.push({ key: 'clients', href: ROUTES.clients, label: 'Clients', icon: 'clients' });
  }
  if (can('ai.chat')) main.push({ key: 'chat', href: ROUTES.chat, label: 'Chat', icon: 'chat' });

  const pepper: NavItem[] = [];
  // Everything Pepper did, in plain words (S52, ADR-0043): staff see what was done for them.
  if (can('business.read')) {
    pepper.push({ key: 'activity', href: ROUTES.activity, label: 'Activity', icon: 'activity' });
  }
  // What Pepper remembers comes from conversations, so it is there for whoever may chat.
  if (can('ai.chat')) {
    pepper.push({ key: 'memory', href: ROUTES.memory, label: 'What I know', icon: 'memory' });
  }
  // Everyone may read the dial; only `autonomy.manage` may change it (the page says so).
  pepper.push({ key: 'autonomy', href: ROUTES.autonomy, label: 'Autonomy', icon: 'dial' });
  if (can('bookings.read')) {
    pepper.push({ key: 'waitlist', href: ROUTES.waitlist, label: 'Waitlist', icon: 'waitlist' });
  }

  const business: NavItem[] = [];
  if (can('services.read')) {
    business.push({ key: 'services', href: ROUTES.services, label: 'Services', icon: 'services' });
  }
  business.push({ key: 'team', href: ROUTES.team, label: 'Team', icon: 'team' });

  return {
    main,
    pepper,
    business,
    more: { key: 'more', href: MORE_HREF, label: 'More', icon: 'more' },
  };
}

/** The phone's bottom tabs: the everyday places, then More (Home · Calendar · Clients · Chat · More). */
export function tabItems(nav: Nav): NavItem[] {
  return nav.more === null ? nav.main : [...nav.main, nav.more];
}

/** Whether `href` is the place `pathname` is in (home only on itself). */
export function isCurrent(pathname: string, href: string): boolean {
  if (href === ROUTES.home) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The key of the place `pathname` is in. On phones every place outside the tabs is reached
 * from More, so it lights More (`tabsOnly`); the sidebar lights the place itself.
 */
export function currentKey(nav: Nav, pathname: string, tabsOnly: boolean): string | null {
  const found = nav.main.find((item) => isCurrent(pathname, item.href));
  if (found !== undefined) return found.key;
  const elsewhere = [...nav.pepper, ...nav.business].find((item) => isCurrent(pathname, item.href));
  if (elsewhere !== undefined) return tabsOnly && nav.more !== null ? nav.more.key : elsewhere.key;
  return nav.more !== null && isCurrent(pathname, nav.more.href) ? nav.more.key : null;
}
