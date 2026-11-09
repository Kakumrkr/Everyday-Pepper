'use client';

import { Button, Input } from '@pepper/ui';
import { useId, useState, type SubmitEvent } from 'react';
import { flushSync } from 'react-dom';
import { checkSignUp, confirmedUrl, ROUTES, withNext, type SignUpField } from '../../lib/account';
import { sendJson } from '../../lib/client-api';
import { formPassword, formText } from '../../lib/form';
import { PRIVACY_PATH, TERMS_PATH } from '@pepper/contracts';
import { AuthPage, TextLink } from './auth-page';
import { CheckInbox } from './check-inbox';
import { Notice } from './form-parts';

/**
 * Creates an account, then asks to confirm the email (S44, AC-W1-5): its link signs in and goes
 * on to `next` (e.g. the invite to accept) or the home page, which asks for the business. A
 * taken address gets the same answer here, and its owner an email (no account oracle).
 */
export function SignUpForm({ next = null }: { next?: string | null }) {
  const formId = useId();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<SignUpField, string>>>({});
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

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
    const result = await sendJson('POST', '/api/auth/sign-up/email', {
      ...fields,
      callbackURL: confirmedUrl(next),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setSentTo(fields.email.trim());
  }

  if (sentTo !== null) return <CheckInbox email={sentTo} next={next} />;

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
        <p className="m-0 type-caption text-ink-2">
          By creating an account you agree to Pepper’s{' '}
          <TextLink href={TERMS_PATH} newTab>
            terms of service
          </TextLink>{' '}
          and{' '}
          <TextLink href={PRIVACY_PATH} newTab>
            privacy policy
          </TextLink>
          .
        </p>
      </form>
      <p className="m-0 type-body text-ink-2">
        Already have an account? <TextLink href={withNext(ROUTES.signIn, next)}>Sign in</TextLink>
      </p>
    </AuthPage>
  );
}
