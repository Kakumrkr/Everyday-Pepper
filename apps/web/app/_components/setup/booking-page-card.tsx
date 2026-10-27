'use client';

import { BusinessSchema } from '@pepper/contracts';
import { brandTokens, buttonClass, LegacyCard } from '@pepper/ui';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { sendJson } from '../../../lib/client-api';
import { Notice } from '../booking/sheet';

/**
 * The business's public booking page (S17): its link, and for owners and managers its color
 * (PCR-001). Any color works: the page adjusts it until its text is readable (WCAG AA).
 */
export function BookingPageCard({
  slug,
  brandColor,
  manages,
}: {
  slug: string;
  brandColor: string | null;
  manages: boolean;
}) {
  const router = useRouter();
  const [color, setColor] = useState(brandColor ?? brandTokens(null).light.biz);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const path = `/book/${slug}`;
  const headingId = useId();

  async function save(next: string | null): Promise<void> {
    setBusy(true);
    const answer = await sendJson('PUT', '/v1/tenant/booking-page', { brandColor: next });
    setBusy(false);
    const parsed = answer.ok ? BusinessSchema.safeParse(answer.data) : null;
    if (parsed?.success !== true) {
      setNotice({ tone: 'error', text: answer.ok ? 'Something went wrong.' : answer.message });
      return;
    }
    setNotice({ tone: 'ok', text: next === null ? 'Back to the default color.' : 'Color saved.' });
    router.refresh();
  }

  return (
    <LegacyCard as="section" labelledBy={headingId}>
      <h2 id={headingId} className="m-0 font-display text-lg font-bold">
        Your booking page
      </h2>
      <p className="mt-1 mb-3 text-ink-2">
        Clients book here themselves, after confirming their email.{' '}
        <a href={path} target="_blank" rel="noreferrer" className="font-semibold text-brand">
          {path}
        </a>
      </p>
      {manages ? (
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 font-semibold">
            Color
            <input
              type="color"
              name="brandColor"
              value={color}
              onChange={(event) => {
                setColor(event.target.value);
              }}
              className="h-11 w-14 cursor-pointer rounded-md border border-line bg-surface p-1"
            />
          </label>
          <button
            type="button"
            disabled={busy}
            className={buttonClass({ size: 'sm' })}
            onClick={() => void save(color)}
          >
            Save color
          </button>
          {brandColor === null ? null : (
            <button
              type="button"
              disabled={busy}
              className={buttonClass({ variant: 'quiet', size: 'sm' })}
              onClick={() => void save(null)}
            >
              Use the default
            </button>
          )}
        </div>
      ) : null}
      {notice === null ? null : (
        <div className="mt-3">
          <Notice tone={notice.tone}>{notice.text}</Notice>
        </div>
      )}
    </LegacyCard>
  );
}
