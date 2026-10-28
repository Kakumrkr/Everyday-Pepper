'use client';

import { Button, buttonStyle, Input } from '@pepper/ui';
import Link from 'next/link';
import { useId, useState, type SubmitEvent } from 'react';
import { flushSync } from 'react-dom';
import { emailError, passwordError, ROUTES } from '../../lib/account';
import { errorCodeOf, sendJson } from '../../lib/client-api';
import { formPassword, formText } from '../../lib/form';
import { AuthPage, TextLink } from './auth-page';
import { Notice } from './form-parts';

// Password reset (S44, AC-W1-4): ask for a link by email, then choose a new password on the
// page the link opens. The first answer is the same whether or not the address has an account.

/** "Forgot your password?": the email, then "Check your inbox". */
export function ForgotPasswordForm() {
  const formId = useId();
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const email = formText(form, 'email');
    const invalid = emailError(email, 'Enter the email you sign in with.');
    flushSync(() => {
      setFieldError(invalid);
      setError(null);
    });
    if (invalid !== undefined) {
      form.querySelector<HTMLElement>('[name="email"]')?.focus();
      return;
    }
    setBusy(true);
    const result = await sendJson('POST', '/api/auth/request-password-reset', {
      email,
      redirectTo: ROUTES.resetPassword,
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
        title="Check your inbox"
        lead={
          <>
            If there’s a Pepper account for{' '}
            <span className="font-semibold break-all text-ink">{sentTo}</span>, a link to choose a
            new password is on its way. It works once, for an hour.
          </>
        }
        action={
          <Link href={ROUTES.signIn} className={buttonStyle({ size: 'lg', block: true })}>
            Back to sign in
          </Link>
        }
      >
        <p className="m-0 type-body text-ink-2">Nothing after a few minutes? Check spam.</p>
        <Button
          variant="quiet"
          className="self-start"
          onClick={() => {
            setSentTo(null);
          }}
        >
          Use another email
        </Button>
      </AuthPage>
    );
  }

  return (
    <AuthPage
      title="Forgot your password?"
      lead="Enter the email you sign in with, and we’ll send you a link to choose a new one."
      action={
        <Button type="submit" form={formId} size="lg" block busy={busy}>
          {busy ? 'Sending…' : 'Send me a link'}
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
          label="Email"
          error={fieldError}
          name="email"
          type="email"
          autoComplete="email"
          required
        />
        {error === null ? null : <Notice tone="error">{error}</Notice>}
      </form>
      <p className="m-0 type-body text-ink-2">
        Remembered it? <TextLink href={ROUTES.signIn}>Sign in</TextLink>
      </p>
    </AuthPage>
  );
}

/** A reset link that no longer works (used, run out, or cut short), with the way on. */
export function ResetLinkExpired() {
  return (
    <AuthPage
      title="This link has run out"
      lead="Reset links work once, for an hour. Ask for a new one and use the newest email."
      action={
        <Link href={ROUTES.forgotPassword} className={buttonStyle({ size: 'lg', block: true })}>
          Send me a new link
        </Link>
      }
    >
      <p className="m-0 type-body text-ink-2">
        Remembered it? <TextLink href={ROUTES.signIn}>Sign in</TextLink>
      </p>
    </AuthPage>
  );
}

/** The page a reset link opens: a new password, then sign in with it. */
export function NewPasswordForm({ token }: { token: string }) {
  const formId = useId();
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<'form' | 'saved' | 'expired'>('form');

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const password = formPassword(form, 'password');
    const invalid = passwordError(password);
    flushSync(() => {
      setFieldError(invalid);
      setError(null);
    });
    if (invalid !== undefined) {
      form.querySelector<HTMLElement>('[name="password"]')?.focus();
      return;
    }
    setBusy(true);
    const result = await sendJson('POST', '/api/auth/reset-password', {
      token,
      newPassword: password,
    });
    setBusy(false);
    if (result.ok) {
      setState('saved');
      return;
    }
    if (errorCodeOf(result.body) === 'INVALID_TOKEN') {
      setState('expired');
      return;
    }
    setError(result.message);
  }

  if (state === 'expired') return <ResetLinkExpired />;
  if (state === 'saved') {
    return (
      <AuthPage
        title="Password saved"
        lead="You’re signed out on your other devices. Sign in with your new password."
        action={
          <Link href={ROUTES.signIn} className={buttonStyle({ size: 'lg', block: true })}>
            Sign in
          </Link>
        }
      />
    );
  }

  return (
    <AuthPage
      title="Choose a new password"
      lead="Saving it signs you out on every other device, so only you are signed in."
      action={
        <Button type="submit" form={formId} size="lg" block busy={busy}>
          {busy ? 'Saving…' : 'Save new password'}
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
          label="New password"
          hint="At least 10 characters. A short sentence works well."
          error={fieldError}
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
        />
        {error === null ? null : <Notice tone="error">{error}</Notice>}
      </form>
    </AuthPage>
  );
}
