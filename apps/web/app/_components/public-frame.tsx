import { cx, FOCUS_RING, Logo } from '@pepper/ui';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { HELP_PATH } from '../../lib/help';
import { LEGAL_DOCUMENTS } from '../../lib/legal';

const FOOTER_LINK = cx(
  'inline-flex min-h-11 items-center type-caption text-ink-2 underline underline-offset-4',
  FOCUS_RING,
);

/**
 * The frame of Pepper's own public pages, the help centre (S59) and the policies (S59.5):
 * Pepper's mark (to the section's home), a way into the app, the page, and the policies at the
 * foot with the help centre. Public, so someone who hasn't signed up, or a client who tapped a link in an email,
 * reads them too.
 */
export function PublicFrame({
  home,
  homeLabel,
  children,
}: {
  home: string;
  homeLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh bg-bg">
      <header className="mx-auto flex w-full max-w-2xl items-center justify-between gap-4 px-5 pt-6">
        <Link
          href={home}
          aria-label={homeLabel}
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
        <Link href={HELP_PATH} className={FOOTER_LINK}>
          Help centre
        </Link>
        {LEGAL_DOCUMENTS.map((doc) => (
          <Link key={doc.path} href={doc.path} className={FOOTER_LINK}>
            {doc.title}
          </Link>
        ))}
      </footer>
    </div>
  );
}
