'use client';

import type { SetupReview } from '@pepper/contracts';
import { Badge, Button, buttonStyle, Card, FOCUS_RING, List, ListRow } from '@pepper/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState } from 'react';
import { sendJson } from '../../../lib/client-api';
import {
  bookingWeekLine,
  setupFix,
  setupRows,
  setupSummary,
  setupTip,
  type SetupFix,
} from '../../../lib/setup-review';
import { IMPORT_PATH } from '../../../lib/imports';
import { kitLink } from '../kit-link';

/**
 * Home's setup review (S46, PCR-009, AC-W1-11/12), for owners and managers. Until someone says
 * "I've checked these", it shows what clients can book (for a new business, what its type filled
 * in; an empty menu only says where to start), each line leading to the
 * screen that changes it; whatever currently stops clients from booking shows above that, and
 * stays after the check until it is fixed. Once checked, the booking page's link stays on Home
 * with a Copy button, to send to clients (S47, AC-W1-13), as a quiet row: nothing to decide.
 */
export function SetupReviewCard({
  review,
  slug,
  offersImport = false,
}: {
  review: SetupReview;
  slug: string;
  /** Offer "Bring your clients" once the setup is checked (S48.2, AC-W1-20). */
  offersImport?: boolean;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reviewed = review.reviewedAt !== null;
  // An empty menu has nothing to check yet: only what to do first.
  const empty = review.services.count === 0;
  const fixes = review.warnings.map(setupFix);
  const tips = review.suggestions.map(setupTip);
  const offer = reviewed && offersImport ? <ImportOffer /> : null;
  if (reviewed && fixes.length === 0) {
    return (
      <>
        <BookingLink slug={slug} week={review.week} tips={tips} />
        {offer}
      </>
    );
  }

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

  const card = (
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
      <Notes notes={fixes} label="Needs fixing" badge="Fix" tone="warn" testId="setup-fix" />
      {reviewed || empty ? null : (
        <>
          <Notes notes={tips} label="Suggestions" badge="Tip" tone="info" testId="setup-tip" />
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
  return reviewed ? (
    <>
      {card}
      <BookingLink slug={slug} week={review.week} tips={tips} />
      {offer}
    </>
  ) : (
    card
  );
}

/**
 * The booking page's full link with Copy (AC-W1-13): what an owner sends to clients; and how
 * the page did this week, in one line (S47.2, AC-W1-14).
 */
function BookingLink({
  slug,
  week,
  tips,
}: {
  slug: string;
  week: SetupReview['week'];
  tips: SetupFix[];
}) {
  const path = `/book/${encodeURIComponent(slug)}`;
  // The page's own origin, known only in the browser; the path until then.
  const [link, setLink] = useState(path);
  const [copied, setCopied] = useState<boolean | null>(null);
  const headingId = useId();
  useEffect(() => {
    setLink(`${window.location.origin}${path}`);
  }, [path]);

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-2 rounded-lg bg-surface p-4"
      data-testid="booking-link"
    >
      <h2 id={headingId} className="m-0 type-subheading text-ink">
        Your booking page
      </h2>
      <p className="m-0 type-body text-ink-2">Send this link to clients so they can book you.</p>
      <p className="m-0 type-label text-ink tabular-nums" data-testid="booking-week">
        {bookingWeekLine(week)}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <a
          href={path}
          target="_blank"
          rel="noreferrer"
          className={`min-w-0 flex-1 font-semibold break-all text-brand ${FOCUS_RING}`}
        >
          {link}
        </a>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(link).then(
              () => {
                setCopied(true);
              },
              () => {
                setCopied(false);
              },
            );
          }}
        >
          {copied === true ? 'Copied' : 'Copy link'}
        </Button>
      </div>
      <Notes notes={tips} label="Suggestions" badge="Tip" tone="info" testId="setup-tip" />
      <p className="m-0 type-caption text-ink-2" role="status">
        {copied === true
          ? 'Copied. Paste it in a message, your bio or your site.'
          : copied === false
            ? 'Couldn’t copy. Press and hold the link to copy it.'
            : ''}
      </p>
    </section>
  );
}

/**
 * "Bring your clients" (S48.2, AC-W1-20): once the setup is checked, the next thing an owner
 * moving from another app does; it goes once an import has finished.
 */
function ImportOffer() {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-2 rounded-lg bg-surface p-4"
      data-testid="import-offer"
    >
      <h2 id={headingId} className="m-0 type-subheading text-ink">
        Bring your clients
      </h2>
      <p className="m-0 type-body text-ink-2">
        Moving from Square, Booksy, Vagaro, GlossGenius or Fresha? Bring your client list over in a
        few minutes, so I know who’s who from the first booking.
      </p>
      <Link
        href={IMPORT_PATH}
        className={`${buttonStyle({ variant: 'secondary', size: 'sm' })} self-start`}
      >
        Bring your clients
      </Link>
    </section>
  );
}

/**
 * Short notes with where to act on each: what stops a booking ("Fix", AC-W1-12) or what would
 * make the page better ("Tip", S47.3, AC-W1-16; quieter, since nothing stops a booking).
 */
function Notes({
  notes,
  label,
  badge,
  tone,
  testId,
}: {
  notes: SetupFix[];
  label: string;
  badge: string;
  tone: 'warn' | 'info';
  testId: string;
}) {
  if (notes.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-3 p-0" aria-label={label}>
      {notes.map((note) => (
        <li
          key={note.key}
          className="flex flex-col gap-2 rounded-md bg-surface-2 p-3"
          data-testid={testId}
        >
          <p className="m-0 flex items-start gap-2 type-body text-ink">
            <Badge tone={tone}>{badge}</Badge>
            <span>{note.text}</span>
          </p>
          <Link
            href={note.action.href}
            className={buttonStyle({ variant: 'secondary', size: 'sm' })}
          >
            {note.action.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}
