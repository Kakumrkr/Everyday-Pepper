'use client';

import { SUPPORT_MESSAGE_MAX, SupportCreatedSchema, type SupportCreated } from '@pepper/contracts';
import { Button, Input, Textarea } from '@pepper/ui';
import { useId, useState, type SubmitEvent } from 'react';
import { sendJson } from '../../../lib/client-api';
import { formText } from '../../../lib/form';
import { TextLink } from '../auth-page';
import { Notice } from '../form-parts';
import { HELP_PATH } from '../../../lib/help';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The form for people who can't sign in (S59, PCR-010, AC-X-17): their email, an optional name
 * and the message. It goes to the Pepper team only; we never email the address typed here, so
 * the answer comes from a person, by reply. `website` is a field people don't see (a honeypot).
 */
export function PublicSupportForm({ topic }: { topic: string | null }) {
  const ids = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<{ email?: string; message?: string }>({});
  const [created, setCreated] = useState<SupportCreated | null>(null);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const email = formText(form, 'email');
    const name = formText(form, 'name');
    const message = formText(form, 'message');
    const website = formText(form, 'website');
    const invalid = {
      ...(!EMAIL.test(email) && { email: 'Enter the email we should answer.' }),
      ...(message === '' && { message: 'Write a few words about it.' }),
    };
    setErrors(invalid);
    setError(null);
    if (Object.keys(invalid).length > 0) {
      form
        .querySelector<HTMLElement>(
          invalid.email === undefined ? '[name="message"]' : '[name="email"]',
        )
        ?.focus();
      return;
    }
    setBusy(true);
    const result = await sendJson('POST', '/v1/public/support', {
      email,
      message,
      ...(name !== '' && { name }),
      ...(website !== '' && { website }),
      ...(topic !== null && /^[a-z0-9-]{1,80}$/.test(topic) && { topic }),
      page: '/help/contact',
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    const parsed = SupportCreatedSchema.safeParse(result.data);
    if (!parsed.success) {
      setError('We got it, but I couldn’t show the reference. You’ll hear from us by email.');
      return;
    }
    setCreated(parsed.data);
  }

  if (created !== null) {
    return (
      <section
        aria-labelledby={`${ids}-sent`}
        className="flex flex-col gap-3 rounded-lg bg-ok-soft px-5 py-6"
        data-testid="support-sent"
      >
        <h2 id={`${ids}-sent`} className="m-0 type-heading text-ink">
          We got it
        </h2>
        <p className="m-0 type-body text-ink">
          Your reference is{' '}
          <span className="font-semibold tabular-nums" data-testid="support-reference">
            {created.reference}
          </span>
          . A person on the Pepper team will write to{' '}
          <span className="font-semibold break-all">{created.replyTo}</span> the same day.
        </p>
        <TextLink href={HELP_PATH}>Back to the help centre</TextLink>
      </section>
    );
  }

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-5">
      <Input
        label="Your email"
        name="email"
        type="email"
        autoComplete="email"
        required
        hint="Where we answer you."
        error={errors.email}
      />
      <Input label="Your name (optional)" name="name" autoComplete="name" maxLength={100} />
      <Textarea
        label="What’s going on?"
        name="message"
        rows={6}
        maxLength={SUPPORT_MESSAGE_MAX}
        required
        hint="What you tried and what happened. Never send a password."
        error={errors.message}
      />
      {/* A field people never see; a bot that fills it in is quietly ignored (AC-X-17). */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
        <label>
          Website
          <input name="website" type="text" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      {error === null ? null : <Notice tone="error">{error}</Notice>}
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? 'Sending…' : 'Send to Pepper'}
        </Button>
      </div>
    </form>
  );
}
