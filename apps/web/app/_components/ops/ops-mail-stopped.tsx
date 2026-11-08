'use client';

import type { SupportMailStop } from '@pepper/contracts';
import { Button } from '@pepper/ui';
import { mailStoppedWords } from '../../../lib/ops';

/**
 * "Mail stopped" on a request (S59.3.2, AC-X-43): the requester's address bounced for good or
 * they marked our email as spam, so Pepper sends them no support email. Resume once the address
 * is fixed (or they asked for it back); each resume is logged.
 */
export function OpsMailStopped({
  stop,
  busy,
  onResume,
}: {
  stop: SupportMailStop;
  busy: boolean;
  onResume: () => void;
}) {
  return (
    <section
      aria-label="Mail stopped"
      data-testid="ops-mail-stopped"
      className="flex flex-col gap-3 rounded-lg bg-warn-soft px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="m-0 flex flex-col gap-1">
        <span className="type-label text-warn">{mailStoppedWords(stop)}</span>
        <span className="type-caption text-ink-2">
          We send them no support email until you resume it. Answers still show in the app.
        </span>
      </p>
      <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={onResume}>
        {busy ? 'Resuming…' : 'Resume mail'}
      </Button>
    </section>
  );
}
