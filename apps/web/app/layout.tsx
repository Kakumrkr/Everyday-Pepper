import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
// Self-hosted (no request to Google at build or run time): Figtree for text, Bricolage
// Grotesque for display (ux-principles.md).
import '@fontsource-variable/figtree';
import '@fontsource-variable/bricolage-grotesque';
import './globals.css';

export const metadata: Metadata = {
  title: 'Pepper',
  description: 'Your AI employee for appointment-based businesses.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F7FAF5' },
    { media: '(prefers-color-scheme: dark)', color: '#0F1510' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
