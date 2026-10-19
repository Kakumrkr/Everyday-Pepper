'use client';

import type { UserBusiness } from '@pepper/contracts';
import { useState } from 'react';
import { ROUTES, withNext } from '../../lib/account';
import { sendJson } from '../../lib/client-api';
import { FormError } from './form-error';

/** Signs out, then shows sign-in (returning to `next` afterwards, if given). */
export function SignOutButton({
  next = null,
  label = 'Sign out',
}: {
  next?: string | null;
  label?: string;
}) {
  return (
    <button
      type="button"
      className="secondary"
      onClick={() => {
        void sendJson('POST', '/api/auth/sign-out', {}).then(() => {
          window.location.assign(withNext(ROUTES.signIn, next));
        });
      }}
    >
      {label}
    </button>
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
      <h2 id="switch-heading">Your businesses</h2>
      <ul className="businesses">
        {businesses.map((business) => (
          <li key={business.tenantId}>
            <button
              type="button"
              className="secondary"
              aria-pressed={business.tenantId === activeTenantId}
              onClick={() => {
                void sendJson('PUT', '/v1/me/active-tenant', { tenantId: business.tenantId }).then(
                  (result) => {
                    if (result.ok) window.location.assign(ROUTES.home);
                    else setError(result.message);
                  },
                );
              }}
            >
              {business.name} <span className="hint">({business.role})</span>
            </button>
          </li>
        ))}
      </ul>
      <FormError message={error} />
    </section>
  );
}
