import { Logo, StickyActionBar } from '@pepper/ui';
import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * The frame of the account screens (sign-in, sign-up, two-step setup, create business, invite;
 * S43.2): the Pepper mark, one title and a line under it, then the form. `action` is the main
 * button, kept at the bottom of the phone within thumb reach (DESIGN D3); the bottom padding
 * keeps the page clear of it.
 */
export function AuthPage({
  title,
  lead,
  action,
  children,
}: {
  title: string;
  lead?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <main className="mx-auto flex w-full min-w-0 max-w-lg flex-col gap-6 px-5 pt-10 pb-32">
      <Logo />
      <header className="flex flex-col gap-2">
        <h1 className="m-0 type-display text-ink">{title}</h1>
        {lead === undefined ? null : <p className="m-0 type-body text-ink-2">{lead}</p>}
      </header>
      {children}
      {action === undefined ? null : <StickyActionBar primary={action} />}
    </main>
  );
}

const TEXT_LINK = 'font-semibold text-brand underline underline-offset-2';

/**
 * A link inside a sentence ("New to Pepper? Create an account"). `reload` loads the page afresh,
 * for a link to the page already open (a form's later step, S44): a client-side visit would keep
 * the step.
 */
export function TextLink({
  href,
  children,
  reload = false,
  newTab = false,
}: {
  href: string;
  children: ReactNode;
  reload?: boolean;
  /** Opens in a new tab, so a half-filled form stays as it is (S59.5: the policies at sign-up). */
  newTab?: boolean;
}) {
  if (newTab) {
    return (
      <a href={href} target="_blank" rel="noopener" className={TEXT_LINK}>
        {children}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    );
  }
  return reload ? (
    <a href={href} className={TEXT_LINK}>
      {children}
    </a>
  ) : (
    <Link href={href} className={TEXT_LINK}>
      {children}
    </Link>
  );
}
