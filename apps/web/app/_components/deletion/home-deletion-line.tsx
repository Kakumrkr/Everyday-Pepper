'use client';

import { buttonStyle, cx } from '@pepper/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { sendJson } from '../../../lib/client-api';
import { BUSINESS_DELETION_PATH } from '../../../lib/deletion';

/**
 * Home's one quiet line while the business is being deleted (S52, the S51.2 retro top-up,
 * AC-W1-45): the day, and for its owner "Keep <name>", which cancels it there and then (the
 * api decides again: owners only). Everyone else reads that the booking page is closed.
 */
export function HomeDeletionLine({
  name,
  dueLabel,
  canKeep,
}: {
  name: string;
  dueLabel: string;
  canKeep: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function keep() {
    setBusy(true);
    setError(null);
    const result = await sendJson('DELETE', BUSINESS_DELETION_PATH, undefined);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    router.refresh();
  }

  return (
    <div
      className="flex flex-wrap items-center gap-x-2 rounded-md bg-info-soft px-4 py-2 type-body text-ink"
      data-testid="home-deletion-line"
    >
      <p className="m-0">
        Pepper deletes {name} on <span className="font-semibold">{dueLabel}</span>.
        {canKeep ? null : ' Its booking page is closed until then.'}
      </p>
      {canKeep ? (
        <button
          type="button"
          disabled={busy}
          aria-busy={busy || undefined}
          className={cx(buttonStyle({ variant: 'quiet', size: 'sm' }), '-ml-4 disabled:opacity-50')}
          onClick={() => void keep()}
        >
          Keep {name}
        </button>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="m-0 w-full type-label text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
