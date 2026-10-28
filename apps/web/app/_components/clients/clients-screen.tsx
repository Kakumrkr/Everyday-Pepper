'use client';

import type { Client } from '@pepper/contracts';
import { useState } from 'react';
import { ClientDirectory } from './client-directory';
import { ClientEditor } from './client-editor';

/**
 * The Clients screen's header and list (S42), one client component so the header's "Add client"
 * and the empty list's "Add your first client" open the same sheet. `manages`: owners and
 * managers (the api decides again); staff see only the clients they have appointments with.
 */
export function ClientsScreen({
  initial,
  manages,
}: {
  initial: Client[] | null;
  manages: boolean;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="m-0 type-display">Clients</h1>
          <p className="m-0 type-body text-ink-2">
            {manages ? 'Everyone who books with you.' : 'The clients you have appointments with.'}
          </p>
        </div>
        {manages ? <ClientEditor open={adding} onOpenChange={setAdding} /> : null}
      </header>
      {initial === null ? (
        <p role="alert" className="m-0 rounded-md bg-warn-soft px-4 py-3 type-label text-warn">
          I couldn’t load your clients. Try again in a moment.
        </p>
      ) : (
        <ClientDirectory
          initial={initial}
          staffView={!manages}
          onAdd={
            manages
              ? () => {
                  setAdding(true);
                }
              : undefined
          }
        />
      )}
    </div>
  );
}
