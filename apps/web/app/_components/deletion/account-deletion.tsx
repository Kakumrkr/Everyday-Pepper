'use client';

import { DeletionStatusSchema } from '@pepper/contracts';
import { Button, Input, List, ListRow } from '@pepper/ui';
import { useRouter } from 'next/navigation';
import { useId, useState, type SubmitEvent } from 'react';
import { flushSync } from 'react-dom';
import { ROUTES } from '../../../lib/account';
import { errorCodeOf, sendJson } from '../../../lib/client-api';
import { ACCOUNT_DELETION_PATH } from '../../../lib/deletion';
import { formText } from '../../../lib/form';
import { AuthPage, TextLink } from '../auth-page';
import { Notice } from '../form-parts';

/**
 * Delete account (S51.2, ADR-0054, AC-W1-42), an account screen (`AuthPage`, with or without a
 * business): what happens and when, then the password; the one main action is "Delete my
 * account", which also signs out every other device. While it
 * waits, the screen says the day and the main action keeps the account. The only owner of a
 * business that isn't being deleted is pointed to deleting the business first (the api
 * refuses it either way).
 */
export function AccountDeletion({
  email,
  dueLabel,
  canDeleteBusiness,
}: {
  email: string;
  /** The day it is deleted, in words; `null` while it isn't being deleted. */
  dueLabel: string | null;
  /** Whether the current business's delete screen is open to this person (its owner). */
  canDeleteBusiness: boolean;
}) {
  const router = useRouter();
  const formId = useId();
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [error, setError] = useState<{ message: string; ownsBusiness: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const password = formText(form, 'password');
    const missing = password === '' ? 'Enter your password.' : undefined;
    flushSync(() => {
      setFieldError(missing);
      setError(null);
    });
    if (missing !== undefined) {
      form.querySelector<HTMLElement>('[name="password"]')?.focus();
      return;
    }
    setBusy(true);
    const result = await sendJson('POST', ACCOUNT_DELETION_PATH, { password });
    setBusy(false);
    if (!result.ok || !DeletionStatusSchema.safeParse(result.data).success) {
      if (!result.ok && errorCodeOf(result.body) === 'wrong_password') {
        setFieldError(result.message);
        form.querySelector<HTMLElement>('[name="password"]')?.focus();
        return;
      }
      setError({
        message: result.ok ? 'Something went wrong. Try again.' : result.message,
        ownsBusiness: !result.ok && errorCodeOf(result.body) === 'account_owns_business',
      });
      return;
    }
    router.refresh();
  }

  async function keep() {
    setError(null);
    setBusy(true);
    const result = await sendJson('DELETE', ACCOUNT_DELETION_PATH, undefined);
    setBusy(false);
    if (!result.ok) {
      setError({ message: result.message, ownsBusiness: false });
      return;
    }
    router.refresh();
  }

  const failure =
    error === null ? null : (
      <Notice tone="error">
        {error.message}
        {error.ownsBusiness && canDeleteBusiness ? (
          <>
            {' '}
            <TextLink href={ROUTES.deleteBusiness}>Delete the business</TextLink>
          </>
        ) : null}
      </Notice>
    );

  if (dueLabel !== null) {
    return (
      <AuthPage
        title="Your account is being deleted"
        lead={
          <span data-testid="account-deletion-due">
            Pepper deletes your account on{' '}
            <span className="font-semibold text-ink">{dueLabel}</span>. Until then you can sign in
            as usual and keep it.
          </span>
        }
        action={
          <Button
            size="lg"
            block
            busy={busy}
            onClick={() => {
              void keep();
            }}
          >
            {busy ? 'Keeping it…' : 'Keep my account'}
          </Button>
        }
      >
        {failure}
        <p className="m-0 type-body text-ink-2">
          Not now? <TextLink href={ROUTES.more}>Back to settings</TextLink>
        </p>
      </AuthPage>
    );
  }

  return (
    <AuthPage
      title="Delete your account"
      lead="Pepper keeps your account for 30 days, then deletes it for good. Sign in any time before then to keep it."
      action={
        <Button type="submit" form={formId} variant="danger" size="lg" block busy={busy}>
          {busy ? 'Deleting…' : 'Delete my account'}
        </Button>
      }
    >
      <section aria-labelledby="account-what" className="flex flex-col gap-1">
        <h2 id="account-what" className="m-0 type-heading">
          What happens
        </h2>
        <List>
          <ListRow
            title="Your other devices are signed out"
            meta="This one stays signed in, so you can change your mind."
          />
          <ListRow
            title="In 30 days, your account is deleted"
            meta={`Your sign-in (${email}), your password and two-step codes, and your place in every team.`}
          />
          <ListRow
            title="Businesses keep their records"
            meta="What you did in a team stays there, linked to no account."
          />
        </List>
      </section>
      <form
        id={formId}
        className="flex flex-col gap-4"
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        <Input
          label="Your password"
          error={fieldError}
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
        {failure}
      </form>
      <p className="m-0 type-body text-ink-2">
        Changed your mind? <TextLink href={ROUTES.more}>Back to settings</TextLink>
      </p>
    </AuthPage>
  );
}
