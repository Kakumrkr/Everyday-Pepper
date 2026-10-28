'use client';

import { Button, Input } from '@pepper/ui';
import { useId, useState, type SubmitEvent } from 'react';
import { ROUTES, withNext } from '../../lib/account';
import { sendJson } from '../../lib/client-api';
import { formPassword, formText } from '../../lib/form';
import { AuthPage, TextLink } from './auth-page';
import { Notice } from './form-parts';

/**
 * Creates an account and signs in; then `next` (e.g. the invite to accept) or the home page,
 * which asks for the business.
 */
export function SignUpForm({ next = null }: { next?: string | null }) {
  const formId = useId();
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
    window.location.assign(next ?? ROUTES.home);
  }

  return (
    <AuthPage
      title="Create your account"
      lead="Pepper books your clients, reminds them and follows up, so you can stay with your clients."
      action={
        <Button type="submit" form={formId} size="lg" block busy={busy}>
          {busy ? 'Creating your account…' : 'Create account'}
        </Button>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-4"
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        <Input label="Your name" name="name" autoComplete="name" required maxLength={120} />
        <Input label="Email" name="email" type="email" autoComplete="email" required />
        <Input
          label="Password"
          hint="At least 10 characters. A short sentence works well."
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
        />
        {error === null ? null : <Notice tone="error">{error}</Notice>}
      </form>
      <p className="m-0 type-body text-ink-2">
        Already have an account? <TextLink href={withNext(ROUTES.signIn, next)}>Sign in</TextLink>
      </p>
    </AuthPage>
  );
}
