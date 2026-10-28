'use client';

import { Button, Input } from '@pepper/ui';
import { useId, useState, type ReactNode, type SubmitEvent } from 'react';
import { sendJson } from '../../lib/client-api';
import { formPassword, formText } from '../../lib/form';
import { ROUTES, withNext } from '../../lib/account';
import { AuthPage, TextLink } from './auth-page';
import { Notice } from './form-parts';

type Step = 'credentials' | 'code' | 'backup-code';

/**
 * Email and password, then (if set up) the authenticator code or a backup code; then `next`
 * (an allowed page, see `safeNext`) or home. `status` says when Pepper can't be reached.
 */
export function SignInForm({
  next = null,
  status = null,
}: {
  next?: string | null;
  status?: ReactNode;
}) {
  const formId = useId();
  const [step, setStep] = useState<Step>('credentials');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    setError(null);
    const result =
      step === 'credentials'
        ? await sendJson<{ twoFactorRedirect?: boolean }>('POST', '/api/auth/sign-in/email', {
            email: formText(form, 'email'),
            password: formPassword(form, 'password'),
          })
        : await sendJson(
            'POST',
            step === 'code'
              ? '/api/auth/two-factor/verify-totp'
              : '/api/auth/two-factor/verify-backup-code',
            { code: formText(form, 'code').replace(/\s/g, '') },
          );
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    if (
      step === 'credentials' &&
      (result.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect
    ) {
      setStep('code');
      return;
    }
    window.location.assign(next ?? ROUTES.home);
  }

  const errorLine = error === null ? null : <Notice tone="error">{error}</Notice>;

  if (step === 'credentials') {
    return (
      <AuthPage
        title="Sign in"
        lead="Welcome back. Sign in to see your day."
        action={
          <Button type="submit" form={formId} size="lg" block busy={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        }
      >
        {status}
        <form
          id={formId}
          className="flex flex-col gap-4"
          onSubmit={(event) => void submit(event)}
          noValidate
        >
          <Input label="Email" name="email" type="email" autoComplete="email" required />
          <Input
            label="Password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
          {errorLine}
        </form>
        <p className="m-0 type-body text-ink-2">
          New to Pepper? <TextLink href={withNext(ROUTES.signUp, next)}>Create an account</TextLink>
        </p>
      </AuthPage>
    );
  }

  const backup = step === 'backup-code';
  return (
    <AuthPage
      key={step}
      title="Two-step verification"
      lead={
        backup
          ? 'Enter one of the backup codes you saved when you turned this on.'
          : 'Enter the 6-digit code your authenticator app shows for Pepper.'
      }
      action={
        <Button type="submit" form={formId} size="lg" block busy={busy}>
          {busy ? 'Checking…' : 'Verify'}
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
          label={backup ? 'Backup code' : 'Code'}
          name="code"
          inputMode={backup ? 'text' : 'numeric'}
          autoComplete="one-time-code"
          required
          autoFocus
        />
        {errorLine}
      </form>
      <Button
        variant="quiet"
        className="self-start"
        onClick={() => {
          setError(null);
          setStep(backup ? 'code' : 'backup-code');
        }}
      >
        {backup ? 'Use the authenticator app instead' : 'Use a backup code instead'}
      </Button>
    </AuthPage>
  );
}
