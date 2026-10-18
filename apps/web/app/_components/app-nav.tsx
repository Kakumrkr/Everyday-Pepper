'use client';

import { cx, Icon, Logo } from '@floty/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { isCurrent, type NavItem } from '../../lib/nav';

/**
 * The app's main navigation: a sidebar from 960 px, bottom tabs within thumb reach below it.
 * Only one of the two is displayed (the other is `display: none`, so out of the a11y tree).
 */
export function AppNav({ items, businessName }: { items: NavItem[]; businessName: string | null }) {
  const pathname = usePathname();
  return (
    <>
      <nav
        aria-label="Main"
        className="sticky top-0 hidden h-dvh flex-col gap-1 border-r border-line bg-surface px-4 py-6 desk:flex"
      >
        <Link href="/" aria-label="Floty home" className="mb-1 px-3 no-underline">
          <Logo />
        </Link>
        {businessName === null ? null : (
          <p className="mb-5 truncate px-3 text-sm text-ink-2" data-testid="nav-business">
            {businessName}
          </p>
        )}
        {items.map((item) => {
          const current = isCurrent(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={current ? 'page' : undefined}
              className={cx(
                'flex min-h-11 items-center gap-3 rounded-sm px-3 font-semibold no-underline',
                current ? 'bg-brand-soft text-ink' : 'text-ink-2 hover:bg-surface-2',
              )}
            >
              <Icon name={item.icon} className={current ? 'text-brand' : undefined} />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-10 flex border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] desk:hidden"
      >
        {items.map((item) => {
          const current = isCurrent(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={current ? 'page' : undefined}
              className={cx(
                'flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-semibold no-underline',
                current ? 'text-brand' : 'text-ink-2',
              )}
            >
              <Icon name={item.icon} />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </>
  );
}
