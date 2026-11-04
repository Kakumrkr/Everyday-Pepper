'use client';

import type { Client } from '@pepper/contracts';
import { buttonStyle } from '@pepper/ui';
import Link from 'next/link';
import { IMPORT_PATH } from '../../../lib/imports';
import { ClientDirectory } from './client-directory';
import { useSheetOpener } from '../use-sheet-opener';
import { ClientEditor } from './client-editor';

/**
 * The Clients screen's header and list (S42), one client component so the header's "Add client"
 * and the empty list's "Add your first client" open the same sheet. `manages`: owners and
 * managers (the api decides again); staff see only the clients they have appointments with.
 */
export function ClientsScreen({
  initial,
  manages,
  importId = null,
}: {
  /** The first page, and the cursor of the next (S50.2); `null` when it couldn't load. */
  initial: { clients: Client[]; nextCursor: string | null } | null;
  manages: boolean;
  /** Only the clients this import added (AC-W1-29). */
  importId?: string | null;
}) {
  const adding = useSheetOpener();
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="m-0 type-display">Clients</h1>
          <p className="m-0 type-body text-ink-2">
            {manages ? 'Everyone who books with you.' : 'The clients you have appointments with.'}
          </p>
        </div>
        {manages ? (
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={IMPORT_PATH}
              className={buttonStyle({ variant: 'secondary' })}
              data-testid="import-clients"
            >
              Import
            </Link>
            <ClientEditor
              open={adding.open}
              onOpenChange={adding.onOpenChange}
              returnFocus={adding.returnFocus}
            />
          </div>
        ) : null}
      </header>
      {initial === null ? (
        <p role="alert" className="m-0 rounded-md bg-warn-soft px-4 py-3 type-label text-warn">
          I couldn’t load your clients. Try again in a moment.
        </p>
      ) : (
        <ClientDirectory
          initial={initial.clients}
          initialCursor={initial.nextCursor}
          staffView={!manages}
          onAdd={manages ? adding.openFromHere : undefined}
          importId={importId}
        />
      )}
    </div>
  );
}
