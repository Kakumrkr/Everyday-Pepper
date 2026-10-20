import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ManageBooking } from '../../../_components/public-booking/manage-booking';
import { BookingPageShell } from '../../../_components/public-booking/page-shell';
import { Unavailable } from '../../../_components/unavailable';
import { publicPage } from '../../../_server/account';

export const dynamic = 'force-dynamic';

interface Params {
  params: Promise<{ slug: string }>;
}

export const metadata: Metadata = {
  title: 'Your booking',
  // The link carries a secret (in the fragment); keep the page out of search results anyway.
  robots: { index: false, follow: false },
};

/**
 * Where the confirmation email's link leads (`/book/<slug>/manage#<token>`). The token never
 * reaches this server: the page reads it in the browser.
 */
export default async function ManageBookingPage({ params }: Params) {
  const page = await publicPage((await params).slug);
  if (page.state === 'missing') notFound();
  if (page.state === 'unavailable') return <Unavailable />;
  return (
    <BookingPageShell business={page.business}>
      <ManageBooking business={page.business} now={Date.now()} />
    </BookingPageShell>
  );
}
