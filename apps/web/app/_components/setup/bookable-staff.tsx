'use client';

import type { Member, Service } from '@pepper/contracts';
import { EmptyState } from '@pepper/ui';
import { useState, type ReactNode } from 'react';
import { ROUTES } from '../../../lib/account';
import { kitLink } from '../kit-link';
import { AddStaffMember } from './staff-form';

/**
 * The Team screen's "Who can be booked" section (S42.2): its heading with "Add staff member",
 * its failed and empty states, and the list from the server as `children`. One client component
 * so the header's button and the empty list's "Add the first person" open the same sheet
 * (AC-X-7). `adds`: owners and managers (the api decides again).
 */
export function BookableStaff({
  adds,
  state,
  services,
  members,
  linkedUserIds,
  children,
}: {
  adds: boolean;
  state: 'failed' | 'empty' | 'listed';
  services: Service[];
  members: Member[] | null;
  linkedUserIds: string[];
  children: ReactNode;
}) {
  const [adding, setAdding] = useState(false);
  // The empty list's button, when it opened the sheet: focus goes back there on close.
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  return (
    <section aria-labelledby="bookable-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="bookable-heading" className="m-0 type-heading">
            Who can be booked
          </h2>
          <p className="m-0 type-body text-ink-2">
            Their hours, time off and the services they offer.
          </p>
        </div>
        {adds ? (
          <AddStaffMember
            services={services}
            members={members}
            linkedUserIds={linkedUserIds}
            open={adding}
            onOpenChange={(next) => {
              // Opened by its own trigger: Radix returns focus there.
              if (next) setOpener(null);
              setAdding(next);
            }}
            returnFocus={opener === null ? undefined : () => (opener.isConnected ? opener : null)}
          />
        ) : null}
      </div>
      {state === 'failed' ? (
        <p role="alert" className="m-0 rounded-md bg-warn-soft px-4 py-3 type-label text-warn">
          I couldn’t load who can be booked. Try again in a moment.
        </p>
      ) : null}
      {state === 'empty' ? (
        adds ? (
          <EmptyState
            icon="team"
            title="No one can be booked yet"
            body="Add yourself and anyone else clients can book, then set their weekly hours."
            action={{
              label: 'Add the first person',
              onClick: () => {
                setOpener(
                  document.activeElement instanceof HTMLElement ? document.activeElement : null,
                );
                setAdding(true);
              },
            }}
          />
        ) : (
          <EmptyState
            icon="team"
            title="No one can be booked yet"
            body="An owner or manager adds who can be booked. Your calendar is ready meanwhile."
            action={{ label: 'Open the calendar', href: ROUTES.calendar, renderLink: kitLink }}
          />
        )
      ) : null}
      {children}
    </section>
  );
}
