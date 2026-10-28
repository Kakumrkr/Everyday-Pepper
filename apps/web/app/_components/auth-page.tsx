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
    <main className="mx-auto flex w-full min-w-0 max-w-md flex-col gap-6 px-5 pt-10 pb-32">
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

/** A link inside a sentence ("New to Pepper? Create an account"). */
export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="font-semibold text-brand underline underline-offset-2">
      {children}
    </Link>
  );
}
