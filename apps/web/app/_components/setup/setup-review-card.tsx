'use client';

import type { SetupReview } from '@pepper/contracts';
import { Badge, Button, buttonStyle, Card, List, ListRow } from '@pepper/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { sendJson } from '../../../lib/client-api';
import { setupFix, setupRows, setupSummary } from '../../../lib/setup-review';
import { kitLink } from '../kit-link';

/**
 * Home's setup review (S46, PCR-009, AC-W1-11/12), for owners and managers. Until someone says
 * "I've checked these", it shows what clients can book (for a new business, what its type filled
 * in; an empty menu only says where to start), each line leading to the
 * screen that changes it; whatever currently stops clients from booking shows above that, and
 * stays after the check until it is fixed. Nothing to check and nothing to fix: no card.
 */
export function SetupReviewCard({ review }: { review: SetupReview }) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reviewed = review.reviewedAt !== null;
  // An empty menu has nothing to check yet: only what to do first.
  const empty = review.services.count === 0;
  const fixes = review.warnings.map(setupFix);
  if (reviewed && fixes.length === 0) return null;

  async function confirm() {
    if (saving) return;
    setSaving(true);
    setError(null);
    const answer = await sendJson('POST', '/v1/setup/review', {});
    if (!answer.ok) {
      setSaving(false);
      setError(answer.message);
      return;
    }
    // Stays disabled until the refreshed Home replaces the card.
    router.refresh();
  }

  return (
    <Card labelledBy="setup-review" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1" data-testid="setup-review">
        <h2 id="setup-review" className="m-0 type-heading">
          {reviewed
            ? 'Before clients can book everything'
            : empty
              ? 'Set up your booking page'
              : 'Check what I set up'}
        </h2>
        {reviewed ? null : empty ? (
          <p className="m-0 type-body text-ink-2">
            Add what you offer and who does it, and clients can book you.
          </p>
        ) : (
          <p className="m-0 type-body text-ink-2">
            <span className="font-semibold text-ink tabular-nums" data-testid="setup-summary">
              {setupSummary(review)}
            </span>
            . This is what clients can book. Change anything that’s off, then tell me it’s right.
          </p>
        )}
      </div>
      {fixes.length === 0 ? null : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0" aria-label="Needs fixing">
          {fixes.map((fix) => (
            <li
              key={fix.key}
              className="flex flex-col gap-2 rounded-md bg-surface-2 p-3"
              data-testid="setup-fix"
            >
              <p className="m-0 flex items-start gap-2 type-body text-ink">
                <Badge tone="warn">Fix</Badge>
                <span>{fix.text}</span>
              </p>
              <Link
                href={fix.action.href}
                className={buttonStyle({ variant: 'secondary', size: 'sm' })}
              >
                {fix.action.label}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {reviewed || empty ? null : (
        <>
          <List label="What I set up">
            {setupRows(review).map((row) => (
              <ListRow
                key={row.key}
                title={row.title}
                meta={row.meta}
                href={row.href}
                renderLink={kitLink}
              />
            ))}
          </List>
          <div className="flex flex-col gap-2">
            <Button block disabled={saving} onClick={() => void confirm()}>
              {saving ? 'Saving…' : 'I’ve checked these'}
            </Button>
            {error === null ? null : (
              <p role="alert" className="m-0 type-body font-semibold text-warn">
                {error}
              </p>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
