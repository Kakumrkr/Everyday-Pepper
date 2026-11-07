'use client';

import {
  OperatorPublicRequestSchema,
  type OperatorPublicRequest,
  type PublicSupportStatus,
} from '@pepper/contracts';
import { Badge, buttonStyle, Segmented } from '@pepper/ui';
import { useState } from 'react';
import { sendJson } from '../../../lib/client-api';
import { OPS_PUBLIC_STATUS, replyByEmailHref } from '../../../lib/ops';
import { supportTime } from '../../../lib/support';
import { Notice } from '../form-parts';
import { OpsNotes } from './ops-notes';

const STATUSES: readonly { value: PublicSupportStatus; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'answered', label: 'Answered' },
  { value: 'solved', label: 'Solved' },
];

function isStatus(value: string): value is PublicSupportStatus {
  return STATUSES.some((status) => status.value === value);
}

/**
 * A request from someone who couldn't sign in (S59.2, AC-X-21): the console never mails a
 * typed address itself (AC-X-17), so the answer goes from the team's own inbox ("Reply by
 * email", the reference in the subject), then "Answered".
 */
export function OpsRequestView({ initial }: { initial: OperatorPublicRequest }) {
  const [request, setRequest] = useState(initial);
  const [busy, setBusy] = useState<'note' | 'status' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const status = OPS_PUBLIC_STATUS[request.status];

  async function call(
    kind: 'note' | 'status',
    method: 'POST' | 'PATCH',
    path: string,
    body: object,
  ) {
    setError(null);
    setBusy(kind);
    const result = await sendJson(method, path, body);
    setBusy(null);
    if (!result.ok) {
      setError(result.message);
      return false;
    }
    const parsed = OperatorPublicRequestSchema.safeParse(result.data);
    if (!parsed.success) {
      setError('Done, but I couldn’t show it. Reload the page.');
      return false;
    }
    setRequest(parsed.data);
    return true;
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="m-0 type-title">Signed-out request</h1>
        <p className="m-0 flex flex-wrap items-center gap-2 type-caption text-ink-2">
          <Badge tone={status.tone}>{status.label}</Badge>
          <span className="tabular-nums">{request.reference}</span>
          <span>
            · {request.name === null ? '' : `${request.name}, `}
            <span className="break-all">{request.email}</span>
          </span>
          <span className="tabular-nums">· {supportTime(request.createdAt, 'UTC', now)} UTC</span>
        </p>
      </header>
      <p className="m-0 rounded-lg border border-line bg-surface px-4 py-3 type-body break-words whitespace-pre-wrap text-ink">
        {request.body}
      </p>
      {request.page === null && request.topic === null ? null : (
        <p className="m-0 type-caption text-ink-2">
          {request.page === null ? null : <>From {request.page}. </>}
          {request.topic === null ? null : <>Article: {request.topic}.</>}
        </p>
      )}
      <div className="flex flex-col gap-2">
        <a
          href={replyByEmailHref(request.email, request.reference)}
          className={buttonStyle({ variant: 'primary' })}
        >
          Reply by email
        </a>
        <p className="m-0 type-caption text-ink-2">
          From the team’s inbox, the reference in the subject. Then mark it answered.
        </p>
      </div>
      {error === null ? null : <Notice tone="error">{error}</Notice>}
      <section className="flex flex-col gap-2">
        <h2 className="m-0 type-label text-ink-2">Status</h2>
        <Segmented
          label="Status"
          options={STATUSES}
          value={request.status}
          onValueChange={(next) => {
            if (busy === null && isStatus(next)) {
              void call('status', 'PATCH', `/v1/ops/requests/${request.id}`, { status: next });
            }
          }}
        />
      </section>
      <OpsNotes
        notes={request.notes}
        now={now}
        busy={busy === 'note'}
        onAdd={(note) => call('note', 'POST', `/v1/ops/requests/${request.id}/notes`, { note })}
      />
    </div>
  );
}
