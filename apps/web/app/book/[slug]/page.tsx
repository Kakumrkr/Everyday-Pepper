import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BookingFlow } from '../../_components/public-booking/booking-flow';
import { BookingPageShell } from '../../_components/public-booking/page-shell';
import { Unavailable } from '../../_components/unavailable';
import { publicPage } from '../../_server/account';

export const dynamic = 'force-dynamic';

interface Params {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const page = await publicPage((await params).slug);
  return { title: page.state === 'found' ? `Book · ${page.business.name}` : 'Book a visit' };
}

/** A business's public booking page (W8): anyone may book, after an emailed code. */
export default async function BookPage({ params }: Params) {
  const page = await publicPage((await params).slug);
  if (page.state === 'missing') notFound();
  if (page.state === 'unavailable') return <Unavailable />;
  return (
    <BookingPageShell business={page.business}>
      <BookingFlow business={page.business} now={Date.now()} />
    </BookingPageShell>
  );
}
