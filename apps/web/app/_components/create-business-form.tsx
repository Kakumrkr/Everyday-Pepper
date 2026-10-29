'use client';

import type { Business, TemplateId, TemplateSummary } from '@pepper/contracts';
import { Button, Input, Select } from '@pepper/ui';
import { useId, useRef, useState, type SubmitEvent } from 'react';
import { ROUTES } from '../../lib/account';
import { sendJson } from '../../lib/client-api';
import { suggestSlug } from '../../lib/slug';
import { browserTimeZone, orderedTimeZones } from '../../lib/time-zones';
import { AuthPage } from './auth-page';
import { BusinessTypePicker } from './business-type-picker';
import { Notice } from './form-parts';

export const TYPE_MISSING = 'Pick your type of business.';
export const NAME_MISSING = 'Enter your business’s name.';

/**
 * Type, name, booking link and time zone of a new business; the creator becomes its owner and
 * its first staff member, and the type pre-fills the menu and hours (S45, ADR-0046).
 */
export function CreateBusinessForm({ types }: { types: readonly TemplateSummary[] }) {
  const formId = useId();
  const [templateId, setTemplateId] = useState<TemplateId | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [typeError, setTypeError] = useState<string | undefined>();
  const [nameError, setNameError] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const firstType = useRef<HTMLInputElement>(null);
  // Built once, around the zone the browser started with.
  const [{ zones, initialZone }] = useState(() => {
    const zone = browserTimeZone();
    return { zones: orderedTimeZones(Intl.supportedValuesOf('timeZone'), zone), initialZone: zone };
  });
  const [timeZone, setTimeZone] = useState(initialZone);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const missingType = templateId === null ? TYPE_MISSING : undefined;
    const missingName = name.trim() === '' ? NAME_MISSING : undefined;
    setTypeError(missingType);
    setNameError(missingName);
    setError(null);
    if (missingType !== undefined) {
      firstType.current?.focus();
      return;
    }
    if (missingName !== undefined) {
      const field = event.currentTarget.elements.namedItem('name');
      if (field instanceof HTMLInputElement) field.focus();
      return;
    }
    setBusy(true);
    const result = await sendJson<Business>('POST', '/v1/tenants', {
      name: name.trim(),
      slug,
      timeZone,
      locale: 'en-US',
      templateId,
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
      lead="Pick your type and we set up your menu and hours, ready for bookings."
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
        <BusinessTypePicker
          types={types}
          value={templateId}
          error={typeError}
          firstRef={firstType}
          onChange={(id) => {
            setTemplateId(id);
            setTypeError(undefined);
          }}
        />
        <Input
          label="Business name"
          name="name"
          error={nameError}
          required
          maxLength={120}
          autoComplete="organization"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            if (event.target.value.trim() !== '') setNameError(undefined);
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
