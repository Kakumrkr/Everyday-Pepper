'use client';

import { BottomTabBar, cx, FOCUS_RING, Icon, Logo } from '@pepper/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { currentKey, tabItems, type Nav, type NavItem } from '../../lib/nav';
import { kitLink } from './kit-link';

/**
 * The app's main navigation (S41, AC-X-5): bottom tabs within thumb reach on phones (Home ·
 * Calendar · Clients · Chat · More), a sidebar from 960 px with the Pepper and business groups.
 * Only one of the two is displayed (the other is `display: none`, so out of the a11y tree).
 */
export function AppNav({ nav, businessName }: { nav: Nav; businessName: string | null }) {
  const pathname = usePathname();
  const sideKey = currentKey(nav, pathname, false);
  const settings: NavItem | null =
    nav.more === null ? null : { ...nav.more, label: 'Settings', icon: 'settings' };
  return (
    <>
      <nav
        aria-label="Main"
        className="sticky top-0 hidden h-dvh flex-col gap-1 overflow-y-auto border-r border-line bg-surface px-4 py-6 desk:flex"
      >
        <Link
          href="/"
          aria-label="Pepper home"
          className={cx('mb-1 px-3 no-underline', FOCUS_RING)}
        >
          <Logo />
        </Link>
        {businessName === null ? null : (
          <p className="m-0 mb-4 truncate px-3 type-caption text-ink-2" data-testid="nav-business">
            {businessName}
          </p>
        )}
        <SideGroup items={nav.main} current={sideKey} />
        <SideGroup title="Pepper" items={nav.pepper} current={sideKey} />
        <SideGroup title="Business" items={nav.business} current={sideKey} />
        {settings === null ? null : (
          <div className="mt-auto pt-4">
            <SideGroup items={[settings]} current={sideKey} />
          </div>
        )}
      </nav>
      <div className="desk:hidden">
        <BottomTabBar
          items={tabItems(nav)}
          current={currentKey(nav, pathname, true) ?? ''}
          renderLink={kitLink}
        />
      </div>
    </>
  );
}

function SideGroup({
  title,
  items,
  current,
}: {
  title?: string;
  items: readonly NavItem[];
  current: string | null;
}) {
  if (items.length === 0) return null;
  return (
    <div className={cx('flex flex-col gap-0.5', title !== undefined && 'mt-5')}>
      {title === undefined ? null : (
        <p className="m-0 mb-1 px-3 type-caption text-ink-3">{title}</p>
      )}
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {items.map((item) => {
          const active = item.key === current;
          return (
            <li key={item.key}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cx(
                  'flex min-h-11 items-center gap-3 rounded-pill px-3 type-label no-underline',
                  active ? 'bg-brand-soft text-ink' : 'text-ink-2 hover:bg-surface-2',
                  FOCUS_RING,
                )}
              >
                <Icon name={item.icon} className={active ? 'text-brand' : undefined} />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
