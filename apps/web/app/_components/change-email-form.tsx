'use client';

import { Button, buttonStyle, Input } from '@pepper/ui';
import Link from 'next/link';
import { useId, useState, type SubmitEvent } from 'react';
import { flushSync } from 'react-dom';
import { newEmailError, ROUTES } from '../../lib/account';
import { sendJson } from '../../lib/client-api';
import { formText } from '../../lib/form';
import { AuthPage, TextLink } from './auth-page';
import { Notice } from './form-parts';

/** Where the new address's link lands: "Your email is changed". */
const CHANGED = `${ROUTES.emailConfirmed}?changed=1`;

/**
 * Change of email (S44, AC-W1-6): the new address gets a link, the old one a notice, and nothing
 * changes until the link is opened. An address that already has an account gets the same answer
 * (no account oracle) and no link.
 */
export function ChangeEmailForm({ current }: { current: string }) {
  const formId = useId();
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const email = formText(form, 'email');
    const invalid = newEmailError(email, current);
    flushSync(() => {
      setFieldError(invalid);
      setError(null);
    });
    if (invalid !== undefined) {
      form.querySelector<HTMLElement>('[name="email"]')?.focus();
      return;
    }
    setBusy(true);
    const result = await sendJson('POST', '/api/auth/change-email', {
      newEmail: email,
      callbackURL: CHANGED,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setSentTo(email);
  }

  if (sentTo !== null) {
    return (
      <AuthPage
        title="Check your new inbox"
        lead={
          <>
            We sent a link to <span className="font-semibold break-all text-ink">{sentTo}</span>.
            Your email changes when you open it. Until then, you sign in with{' '}
            <span className="font-semibold break-all text-ink">{current}</span>.
          </>
        }
        action={
          <Link href={ROUTES.more} className={buttonStyle({ size: 'lg', block: true })}>
            Back to settings
          </Link>
        }
      >
        <p className="m-0 type-body text-ink-2">
          We also told {current}, in case this wasn’t you. The link works for 24 hours.
        </p>
      </AuthPage>
    );
  }

  return (
    <AuthPage
      title="Change your email"
      lead={
        <>
          You sign in with <span className="font-semibold break-all text-ink">{current}</span>.
          We’ll send a link to the new address to make sure it’s yours.
        </>
      }
      action={
        <Button type="submit" form={formId} size="lg" block busy={busy}>
          {busy ? 'Sending…' : 'Send the link'}
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
          label="New email"
          error={fieldError}
          name="email"
          type="email"
          autoComplete="email"
          required
        />
        {error === null ? null : <Notice tone="error">{error}</Notice>}
      </form>
      <p className="m-0 type-body text-ink-2">
        Changed your mind? <TextLink href={ROUTES.more}>Back to settings</TextLink>
      </p>
    </AuthPage>
  );
}
