'use client';

import type { UserBusiness } from '@pepper/contracts';
import { Button, cx, FOCUS_RING, Icon } from '@pepper/ui';
import { useState } from 'react';
import { ROUTES, withNext } from '../../lib/account';
import { sendJson } from '../../lib/client-api';
import { Notice } from './form-parts';

/**
 * Signs out, then shows sign-in (returning to `next` afterwards, if given). `main` makes it the
 * screen's one primary action (the invite for another email).
 */
export function SignOutButton({
  next = null,
  label = 'Sign out',
  main = false,
}: {
  next?: string | null;
  label?: string;
  main?: boolean;
}) {
  return (
    <Button
      variant={main ? 'primary' : 'secondary'}
      size={main ? 'lg' : 'md'}
      block={main}
      onClick={() => {
        void sendJson('POST', '/api/auth/sign-out', {}).then(() => {
          window.location.assign(withNext(ROUTES.signIn, next));
        });
      }}
    >
      {label}
    </Button>
  );
}

/** Switches the session to another of the user's businesses. */
export function BusinessSwitcher({
  businesses,
  activeTenantId,
}: {
  businesses: UserBusiness[];
  activeTenantId: string | null;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <section aria-labelledby="switch-heading">
      <h2 id="switch-heading" className="m-0 mb-1 type-heading">
        Your businesses
      </h2>
      <ul className="m-0 list-none divide-y divide-line p-0">
        {businesses.map((business) => {
          const active = business.tenantId === activeTenantId;
          return (
            <li key={business.tenantId} className="-mx-2">
              <button
                type="button"
                aria-pressed={active}
                className={cx(
                  'flex min-h-14 w-full items-center gap-3 rounded-sm bg-transparent px-2 py-3 text-left text-ink hover:bg-surface-2',
                  FOCUS_RING,
                )}
                onClick={() => {
                  void sendJson('PUT', '/v1/me/active-tenant', {
                    tenantId: business.tenantId,
                  }).then((result) => {
                    if (result.ok) window.location.assign(ROUTES.home);
                    else setError(result.message);
                  });
                }}
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate type-body font-semibold">{business.name}</span>
                  <span className="type-caption text-ink-2">{business.role}</span>
                </span>
                {active ? <Icon name="check" className="text-brand" /> : null}
              </button>
            </li>
          );
        })}
      </ul>
      {error === null ? null : <Notice tone="error">{error}</Notice>}
    </section>
  );
}
