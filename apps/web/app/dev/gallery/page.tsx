import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { galleryEnabled } from '../../../lib/gallery';
import { Gallery } from './gallery';

// Read the flag per request, so one image serves CI (on) and the pilot (off).
export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Component gallery · Pepper',
  robots: { index: false, follow: false },
};

/** Every component of the kit in its states, on Southside Cuts' data (S40, AC-X-4). */
export default function GalleryPage() {
  if (!galleryEnabled(process.env)) notFound();
  return <Gallery />;
}
