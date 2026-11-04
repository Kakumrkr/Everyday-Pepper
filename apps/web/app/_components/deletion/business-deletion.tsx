'use client';

import { DeletionStatusSchema } from '@pepper/contracts';
import { Button, Input, List, ListRow } from '@pepper/ui';
import { useRouter } from 'next/navigation';
import { useId, useState, type SubmitEvent } from 'react';
import { flushSync } from 'react-dom';
import { sendJson } from '../../../lib/client-api';
import { BUSINESS_DELETION_PATH } from '../../../lib/deletion';
import { formText } from '../../../lib/form';
import { ExportDownload } from '../export-download';
import { Notice } from '../form-parts';
import { TabActionBar } from '../tab-action-bar';

/**
 * Delete business (S51.2, ADR-0054, AC-W1-40): first "Download your data" (the S51 retro's
 * top-up), then what happens and when, then the business's name typed to confirm; the one
 * main action is "Delete <name>". While it waits, the screen says the day and the main action
 * keeps the business. The api decides again (owners only, the name, the day).
 */
export function BusinessDeletion({
  name,
  dueLabel,
}: {
  name: string;
  /** The day it is deleted, in words; `null` while it isn't being deleted. */
  dueLabel: string | null;
}) {
  const router = useRouter();
  const formId = useId();
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const typed = formText(form, 'confirmName');
    const missing = typed === '' ? `Type ${name} to confirm.` : undefined;
    flushSync(() => {
      setFieldError(missing);
      setError(null);
    });
    if (missing !== undefined) {
      form.querySelector<HTMLElement>('[name="confirmName"]')?.focus();
      return;
    }
    setBusy(true);
    const result = await sendJson('POST', BUSINESS_DELETION_PATH, { confirmName: typed });
    setBusy(false);
    if (!result.ok || !DeletionStatusSchema.safeParse(result.data).success) {
      setError(result.ok ? 'Something went wrong. Try again.' : result.message);
      return;
    }
    router.refresh();
  }

  async function keep() {
    setError(null);
    setBusy(true);
    const result = await sendJson('DELETE', BUSINESS_DELETION_PATH, undefined);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    router.refresh();
  }

  if (dueLabel !== null) {
    return (
      <div className="flex flex-col gap-6">
        <p className="m-0 type-body text-ink" data-testid="business-deletion-due">
          Pepper deletes {name} on <span className="font-semibold">{dueLabel}</span>. Until then
          your team can keep working in it, and you can keep it.
        </p>
        <List>
          <ListRow title="Your booking page is closed" meta="Clients can still cancel a visit." />
          <ListRow
            title="Pepper sends your clients nothing"
            meta="No reminders or other emails go out."
          />
        </List>
        {error === null ? null : <Notice tone="error">{error}</Notice>}
        <TabActionBar testId="deletion-actions">
          <Button
            className="w-full desk:w-auto"
            busy={busy}
            onClick={() => {
              void keep();
            }}
          >
            {busy ? 'Keeping it…' : `Keep ${name}`}
          </Button>
        </TabActionBar>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="deletion-first" className="flex flex-col gap-3">
        <h2 id="deletion-first" className="m-0 type-heading">
          First, take your data
        </h2>
        <p className="m-0 type-body text-ink-2">
          One file with your clients, visits, team and services. You can bring it to another app, or
          back to Pepper.
        </p>
        <ExportDownload placement="inline" />
      </section>
      <section aria-labelledby="deletion-what" className="flex flex-col gap-1">
        <h2 id="deletion-what" className="m-0 type-heading">
          What happens
        </h2>
        <List>
          <ListRow
            title="Your booking page closes at once"
            meta="Clients can still cancel a visit they have."
          />
          <ListRow
            title="Pepper stops emailing your clients"
            meta="Tell clients with upcoming visits yourself."
          />
          <ListRow
            title="In 30 days, everything is deleted"
            meta="Clients, visits, the team, photos and what Pepper knows. Until then you can keep it."
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
          label={`Type ${name} to confirm`}
          error={fieldError}
          name="confirmName"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          required
        />
        {error === null ? null : <Notice tone="error">{error}</Notice>}
      </form>
      <TabActionBar testId="deletion-actions">
        <Button
          type="submit"
          form={formId}
          variant="danger"
          className="w-full desk:w-auto"
          busy={busy}
        >
          {busy ? 'Deleting…' : `Delete ${name}`}
        </Button>
      </TabActionBar>
    </div>
  );
}
