'use client';

import { Button, buttonStyle } from '@pepper/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { newRequestHref } from '../../lib/support';

/**
 * A screen of the signed-in app that broke (S59, AC-X-14): say so plainly, offer to try again,
 * and offer "Tell us what went wrong" with the page and the error's reference filled in, so the
 * team can find it in the logs without the owner describing it.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const pathname = usePathname();
  const reference = error.digest;
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4" role="alert">
      <h1 className="m-0 type-display">This screen didn’t load</h1>
      <p className="m-0 type-body text-ink-2">
        Something went wrong on our side. Your data is safe. Try again, and if it happens again,
        tell us: we’ll see exactly what broke.
      </p>
      {reference === undefined ? null : (
        <p className="m-0 type-caption text-ink-2">
          Reference <span className="tabular-nums">{reference}</span>
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <Button onClick={reset}>Try again</Button>
        <Link
          href={newRequestHref({
            page: pathname,
            ...(reference !== undefined && { error: reference }),
          })}
          className={buttonStyle({ variant: 'secondary' })}
        >
          Tell us what went wrong
        </Link>
      </div>
    </div>
  );
}
