'use client';

import type { Business } from '@pepper/contracts';
import { Button, Input, Select } from '@pepper/ui';
import { useId, useMemo, useState, type SubmitEvent } from 'react';
import { ROUTES } from '../../lib/account';
import { sendJson } from '../../lib/client-api';
import { suggestSlug } from '../../lib/slug';
import { AuthPage } from './auth-page';
import { Notice } from './form-parts';

/** Name, booking link and time zone of a new business; the creator becomes its owner. */
export function CreateBusinessForm() {
  const formId = useId();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const zones = useMemo(
    () =>
      Intl.supportedValuesOf('timeZone').map((zone) => ({
        value: zone,
        label: zone.replaceAll('_', ' '),
      })),
    [],
  );
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
    <AuthPage
      title="Tell us about your business"
      lead="Three things and you’re in. You can change them later."
      action={
        <Button type="submit" form={formId} size="lg" block busy={busy}>
          {busy ? 'Creating your business…' : 'Create business'}
        </Button>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-4"
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        <Input
          label="Business name"
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
        <Input
          label="Booking link"
          hint={`Clients book at pepper.app/${slug === '' ? 'your-business' : slug}. Lowercase letters, digits and hyphens.`}
          name="slug"
          required
          maxLength={63}
          pattern="[a-z][a-z0-9\-]{2,62}"
          autoCapitalize="none"
          spellCheck={false}
          value={slug}
          onChange={(event) => {
            setSlugEdited(true);
            setSlug(event.target.value.toLowerCase());
          }}
        />
        <Select
          label="Time zone"
          hint="Your hours and every booking use this clock."
          name="timeZone"
          options={zones}
          value={timeZone}
          onChange={(event) => {
            setTimeZone(event.target.value);
          }}
        />
        {error === null ? null : <Notice tone="error">{error}</Notice>}
      </form>
    </AuthPage>
  );
}
