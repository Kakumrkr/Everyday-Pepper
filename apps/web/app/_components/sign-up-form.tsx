'use client';

import { Button, Input } from '@pepper/ui';
import { useId, useState, type SubmitEvent } from 'react';
import { flushSync } from 'react-dom';
import { checkSignUp, ROUTES, withNext, type SignUpField } from '../../lib/account';
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
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<SignUpField, string>>>({});
  const [busy, setBusy] = useState(false);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = {
      name: formText(form, 'name'),
      email: formText(form, 'email'),
      password: formPassword(form, 'password'),
    };
    const errors = checkSignUp(fields);
    flushSync(() => {
      setFieldErrors(errors);
      setError(null);
    });
    // To the first field to fix, so a screen reader reads its error (its description).
    const first = (['name', 'email', 'password'] as const).find((field) => field in errors);
    if (first !== undefined) {
      form.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
      return;
    }
    setBusy(true);
    const result = await sendJson('POST', '/api/auth/sign-up/email', fields);
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
      lead="Pepper books your clients, reminds them and follows up, so your hands stay free for the work."
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
        <Input
          label="Your name"
          error={fieldErrors.name}
          name="name"
          autoComplete="name"
          required
          maxLength={120}
        />
        <Input
          label="Email"
          error={fieldErrors.email}
          name="email"
          type="email"
          autoComplete="email"
          required
        />
        <Input
          label="Password"
          hint="At least 10 characters. A short sentence works well."
          error={fieldErrors.password}
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
