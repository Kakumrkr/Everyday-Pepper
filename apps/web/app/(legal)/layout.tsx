import { cx, FOCUS_RING, Logo } from '@pepper/ui';
import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * The legal pages' frame (S59.5, AC-X-54): public, like the help centre, so a client who taps
 * the line in an email or a visitor before sign-up reads them too. Pepper's mark and the page.
 */
export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-bg">
      <header className="mx-auto flex w-full max-w-2xl items-center justify-between gap-4 px-5 pt-6">
        <Link
          href="/"
          aria-label="Pepper"
          className={cx('inline-flex min-h-11 items-center no-underline', FOCUS_RING)}
        >
          <Logo />
        </Link>
      </header>
      <main className="mx-auto flex w-full min-w-0 max-w-2xl flex-col gap-6 px-5 pt-8 pb-16">
        {children}
      </main>
    </div>
  );
}
