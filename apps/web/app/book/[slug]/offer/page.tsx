import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ClaimOffer } from '../../../_components/public-booking/claim-offer';
import { BookingPageShell } from '../../../_components/public-booking/page-shell';
import { Unavailable } from '../../../_components/unavailable';
import { publicPage } from '../../../_server/account';

export const dynamic = 'force-dynamic';

interface Params {
  params: Promise<{ slug: string }>;
}

export const metadata: Metadata = {
  title: 'A time opened up',
  // The link carries a secret (in the fragment); keep the page out of search results anyway.
  robots: { index: false, follow: false },
};

/**
 * Where a waitlist offer email's link leads (`/book/<slug>/offer#<token>`, S37). The secret
 * never reaches this server: the page reads it in the browser, and opening it changes nothing
 * (mail scanners open links); only the client's tap claims the time.
 */
export default async function OfferPage({ params }: Params) {
  const page = await publicPage((await params).slug);
  if (page.state === 'missing') notFound();
  if (page.state === 'unavailable') return <Unavailable />;
  return (
    <BookingPageShell business={page.business}>
      <ClaimOffer business={page.business} />
    </BookingPageShell>
  );
}
