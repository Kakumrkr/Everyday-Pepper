'use client';

import { ReviewUrlSchema } from '@pepper/contracts';
import { ReviewLink } from '@pepper/ui';
import { useRouter } from 'next/navigation';
import { saveFeedSettings } from '../../../lib/feed-settings';

/**
 * Where review requests send clients (S55.2, ADR-0059), in More beside the mailing address:
 * owners and managers only; a link that isn't a full `https` address is answered here, before
 * any request; saving refreshes the page.
 */
export function ReviewLinkSetting({
  url,
  addressSet,
}: {
  url: string | null;
  addressSet: boolean;
}) {
  const router = useRouter();
  return (
    <ReviewLink
      url={url}
      addressSet={addressSet}
      onSave={(reviewUrl) => {
        if (reviewUrl !== null && !ReviewUrlSchema.safeParse(reviewUrl).success) {
          return Promise.resolve('Enter the full address, starting with https://');
        }
        return saveFeedSettings({ reviewUrl }, () => {
          router.refresh();
        });
      }}
    />
  );
}
