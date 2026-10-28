import type { Metadata } from 'next';
import { Unsubscribe } from '../../_components/unsubscribe';

export const dynamic = 'force-dynamic';

interface Params {
  params: Promise<{ token: string }>;
}

export const metadata: Metadata = {
  title: 'Unsubscribe',
  // The link carries a secret; keep the page out of search results.
  robots: { index: false, follow: false },
};

/**
 * Where a rebooking email's "Unsubscribe" link leads (S36, ADR-0040): no sign-in. Opening it
 * changes nothing (mail scanners open links); the button unsubscribes.
 */
export default async function UnsubscribePage({ params }: Params) {
  return (
    <main className="mx-auto flex w-full min-w-0 max-w-md flex-col gap-5 self-start rounded-none border-0 bg-transparent px-5 pt-10 pb-10">
      <Unsubscribe token={(await params).token} />
    </main>
  );
}
