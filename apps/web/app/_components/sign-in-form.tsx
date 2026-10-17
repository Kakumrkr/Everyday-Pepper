'use client';

import Link from 'next/link';
import { useState, type SubmitEvent } from 'react';
import { sendJson } from '../../lib/client-api';
import { formPassword, formText } from '../../lib/form';
import { ROUTES, withNext } from '../../lib/account';
import { FormError } from './form-error';

type Step = 'credentials' | 'code' | 'backup-code';

/**
 * Email and password, then (if set up) the authenticator code or a backup code; then `next`
 * (an allowed page, see `safeNext`) or home.
 */
export function SignInForm({ next = null }: { next?: string | null }) {
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

  if (step === 'credentials') {
    return (
      <form className="form" onSubmit={(event) => void submit(event)} noValidate>
        <label>
          Email
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <FormError message={error} />
        <button type="submit" disabled={busy}>
          Sign in
        </button>
        <p className="hint">
          New to Floty? <Link href={withNext(ROUTES.signUp, next)}>Create an account</Link>
        </p>
      </form>
    );
  }

  const backup = step === 'backup-code';
  return (
    <form className="form" onSubmit={(event) => void submit(event)} noValidate key={step}>
      <h2>Two-step verification</h2>
      <p className="hint">
        {backup
          ? 'Enter one of the backup codes you saved.'
          : 'Enter the 6-digit code from your authenticator app.'}
      </p>
      <label>
        {backup ? 'Backup code' : 'Code'}
        <input
          name="code"
          inputMode={backup ? 'text' : 'numeric'}
          autoComplete="one-time-code"
          required
          autoFocus
        />
      </label>
      <FormError message={error} />
      <button type="submit" disabled={busy}>
        Verify
      </button>
      <button
        type="button"
        className="link-button"
        onClick={() => {
          setError(null);
          setStep(backup ? 'code' : 'backup-code');
        }}
      >
        {backup ? 'Use the authenticator app instead' : 'Use a backup code instead'}
      </button>
    </form>
  );
}
