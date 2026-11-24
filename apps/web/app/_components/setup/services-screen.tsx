'use client';

import type { DepositAudience } from '@pepper/contracts';
import { EmptyState } from '@pepper/ui';
import { useState, type ReactNode } from 'react';
import { ROUTES } from '../../../lib/account';
import { kitLink } from '../kit-link';
import { ServiceEditor, type DepositsState } from './service-editor';

/**
 * The Services screen's header, its empty and failed states, and the menu below (S42.2): one
 * client component so the header's "Add service" and the empty menu's "Add your first service"
 * open the same sheet (AC-X-7). The menu itself comes from the server as `children`.
 */
export function ServicesScreen({
  manages,
  categories,
  state,
  actions,
  deposits,
  audience = 'everyone',
  children,
}: {
  /** Owners and managers (the api decides again). */
  manages: boolean;
  categories: string[];
  state: 'failed' | 'empty' | 'listed';
  /** The header's other actions (Booking rules). */
  actions: ReactNode;
  /** Whether the deposit field shows in the sheet (S66.2). */
  deposits: DepositsState;
  /** Who pays a deposit (S67, AC-X-128): the sheet says so under the field. */
  audience?: DepositAudience;
  children: ReactNode;
}) {
  // Focus goes back to the header's button on close, opened from either: a save replaces the
  // empty state, and its button with it, once the page refreshes (S42.2 walkthrough).
  const [adding, setAdding] = useState(false);
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="m-0 type-display">Services</h1>
          <p className="m-0 type-body text-ink-2">
            What clients can book, how long it takes and the price.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {actions}
          {manages ? (
            <ServiceEditor
              categories={categories}
              open={adding}
              onOpenChange={setAdding}
              deposits={deposits}
              audience={audience}
            />
          ) : null}
        </div>
      </header>
      {state === 'failed' ? (
        <p role="alert" className="m-0 rounded-md bg-warn-soft px-4 py-3 type-label text-warn">
          I couldn’t load your services. Try again in a moment.
        </p>
      ) : null}
      {state === 'empty' ? (
        manages ? (
          <EmptyState
            icon="services"
            title="No services yet"
            body="Add what you offer and how long it takes. Then choose who offers it on the Team page."
            action={{
              label: 'Add your first service',
              onClick: () => {
                setAdding(true);
              },
            }}
          />
        ) : (
          <EmptyState
            icon="services"
            title="No services yet"
            body="An owner or manager adds the services you offer here. Your calendar is ready meanwhile."
            action={{ label: 'Open the calendar', href: ROUTES.calendar, renderLink: kitLink }}
          />
        )
      ) : null}
      {children}
    </div>
  );
}
