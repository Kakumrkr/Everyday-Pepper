'use client';

import { MailingAddress } from '@pepper/ui';
import { useRouter } from 'next/navigation';
import { saveFeedSettings } from '../../../lib/feed-settings';

/**
 * The mailing address rebooking emails carry (S36, ADR-0040), in More's settings since S41
 * (it was the foot of Home's suggestions): owners and managers only; saving refreshes the page.
 */
export function MailingAddressSetting({ address }: { address: string | null }) {
  const router = useRouter();
  return (
    <MailingAddress
      address={address}
      onSave={(mailingAddress) =>
        saveFeedSettings({ mailingAddress }, () => {
          router.refresh();
        })
      }
    />
  );
}
