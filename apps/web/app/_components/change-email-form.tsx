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

/**
 * Change of email (S44, AC-W1-6): the current address confirms by a link first, then the new one
 * by another (the api sets where each lands); nothing changes before both. An address that
 * already has an account gets the same answer here (no account oracle) and no link.
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
      callbackURL: ROUTES.emailConfirmed,
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
        title="Confirm it’s you"
        lead={
          <>
            We sent a link to your current email,{' '}
            <span className="font-semibold break-all text-ink">{current}</span>. Open it, then the
            one we send to <span className="font-semibold break-all text-ink">{sentTo}</span>.
          </>
        }
        action={
          <Link href={ROUTES.more} className={buttonStyle({ size: 'lg', block: true })}>
            Back to settings
          </Link>
        }
      >
        <p className="m-0 type-body text-ink-2">
          Nothing changes until both links are opened. They work for 24 hours.
        </p>
      </AuthPage>
    );
  }

  return (
    <AuthPage
      title="Change your email"
      lead={
        <>
          You sign in with <span className="font-semibold break-all text-ink">{current}</span>. To
          keep your account safe, we’ll ask both addresses to confirm.
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
