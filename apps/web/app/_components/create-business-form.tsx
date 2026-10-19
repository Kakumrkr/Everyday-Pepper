'use client';

import type { Business } from '@pepper/contracts';
import { useMemo, useState, type SubmitEvent } from 'react';
import { ROUTES } from '../../lib/account';
import { sendJson } from '../../lib/client-api';
import { suggestSlug } from '../../lib/slug';
import { FormError } from './form-error';

/** Name, booking link and time zone of a new business; the creator becomes its owner. */
export function CreateBusinessForm() {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const zones = useMemo(() => Intl.supportedValuesOf('timeZone'), []);
  const [timeZone, setTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await sendJson<Business>('POST', '/v1/tenants', {
      name: name.trim(),
      slug,
      timeZone,
      locale: 'en-US',
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    window.location.assign(ROUTES.home);
  }

  return (
    <form className="form" onSubmit={(event) => void submit(event)} noValidate>
      <label>
        Business name
        <input
          name="name"
          required
          maxLength={120}
          autoComplete="organization"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            if (!slugEdited) setSlug(suggestSlug(event.target.value));
          }}
        />
      </label>
      <label>
        Booking link
        <span className="prefixed">
          <span aria-hidden="true">pepper.app/</span>
          <input
            name="slug"
            required
            maxLength={63}
            pattern="[a-z][a-z0-9\-]{2,62}"
            aria-describedby="slug-hint"
            value={slug}
            onChange={(event) => {
              setSlugEdited(true);
              setSlug(event.target.value.toLowerCase());
            }}
          />
        </span>
      </label>
      <p className="hint" id="slug-hint">
        Lowercase letters, digits and hyphens. Clients book at this link.
      </p>
      <label>
        Time zone
        <select
          name="timeZone"
          value={timeZone}
          onChange={(event) => {
            setTimeZone(event.target.value);
          }}
        >
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone.replaceAll('_', ' ')}
            </option>
          ))}
        </select>
      </label>
      <FormError message={error} />
      <button type="submit" disabled={busy}>
        Create business
      </button>
    </form>
  );
}
