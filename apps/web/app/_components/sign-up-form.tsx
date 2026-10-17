'use client';

import Link from 'next/link';
import { useState, type SubmitEvent } from 'react';
import { ROUTES } from '../../lib/account';
import { sendJson } from '../../lib/client-api';
import { formPassword, formText } from '../../lib/form';
import { FormError } from './form-error';

/** Creates an account and signs in; the home page then asks for the business. */
export function SignUpForm() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    setError(null);
    const result = await sendJson('POST', '/api/auth/sign-up/email', {
      name: formText(form, 'name'),
      email: formText(form, 'email'),
      password: formPassword(form, 'password'),
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
        Your name
        <input name="name" autoComplete="name" required maxLength={120} />
      </label>
      <label>
        Email
        <input name="email" type="email" autoComplete="email" required />
      </label>
      <label>
        Password
        <input
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          aria-describedby="password-hint"
        />
      </label>
      <p className="hint" id="password-hint">
        At least 10 characters. A short sentence works well.
      </p>
      <FormError message={error} />
      <button type="submit" disabled={busy}>
        Create account
      </button>
      <p className="hint">
        Already have an account? <Link href={ROUTES.signIn}>Sign in</Link>
      </p>
    </form>
  );
}
