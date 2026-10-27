'use client';

import { FeedSettingsSchema } from '@pepper/contracts';
import { MailingAddress } from '@pepper/ui';
import { useRouter } from 'next/navigation';
import { sendJson } from '../../../lib/client-api';

/**
 * The mailing address rebooking emails carry (S36, ADR-0040), in More's settings since S41
 * (it was the foot of Home's suggestions): owners and managers only; saving refreshes the page.
 */
export function MailingAddressSetting({ address }: { address: string | null }) {
  const router = useRouter();
  return (
    <MailingAddress
      address={address}
      onSave={async (mailingAddress) => {
        const answer = await sendJson('PATCH', '/v1/feed/settings', { mailingAddress });
        if (!answer.ok) return answer.message;
        if (!FeedSettingsSchema.safeParse(answer.data).success) return 'Something went wrong.';
        router.refresh();
        return null;
      }}
    />
  );
}
