import { cx, FOCUS_RING, Logo } from '@pepper/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { PRIVACY_PATH, TERMS_PATH } from '@pepper/contracts';
import { HELP_PATH } from '../../lib/help';

export const metadata: Metadata = { title: 'Help · Pepper' };

/**
 * The help centre's frame (S59, PCR-010, AC-X-13): public, so someone who hasn't signed up or
 * can't sign in reads it too. Pepper's mark, a way back to the app, and the page.
 */
export default function HelpLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-bg">
      <header className="mx-auto flex w-full max-w-2xl items-center justify-between gap-4 px-5 pt-6">
        <Link
          href={HELP_PATH}
          aria-label="Pepper help centre"
          className={cx('inline-flex min-h-11 items-center no-underline', FOCUS_RING)}
        >
          <Logo />
        </Link>
        <Link
          href="/"
          className={cx(
            'inline-flex min-h-11 items-center type-label text-brand underline underline-offset-4',
            FOCUS_RING,
          )}
        >
          Open Pepper
        </Link>
      </header>
      <main className="mx-auto flex w-full min-w-0 max-w-2xl flex-col gap-6 px-5 pt-8 pb-16">
        {children}
      </main>
      <footer className="mx-auto flex w-full max-w-2xl gap-4 border-t border-line px-5 pt-2 pb-8">
        <Link
          href={PRIVACY_PATH}
          className={cx(
            'inline-flex min-h-11 items-center type-caption text-ink-2 underline underline-offset-4',
            FOCUS_RING,
          )}
        >
          Privacy policy
        </Link>
        <Link
          href={TERMS_PATH}
          className={cx(
            'inline-flex min-h-11 items-center type-caption text-ink-2 underline underline-offset-4',
            FOCUS_RING,
          )}
        >
          Terms of service
        </Link>
      </footer>
    </div>
  );
}
