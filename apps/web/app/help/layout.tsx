import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { HELP_PATH } from '../../lib/help';
import { PublicFrame } from '../_components/public-frame';

export const metadata: Metadata = { title: 'Help · Pepper' };

/**
 * The help centre's frame (S59, PCR-010, AC-X-13): public, so someone who hasn't signed up or
 * can't sign in reads it too. Since S59.5 the policies are linked at the foot (AC-X-54).
 */
export default function HelpLayout({ children }: { children: ReactNode }) {
  return (
    <PublicFrame home={HELP_PATH} homeLabel="Pepper help centre">
      {children}
    </PublicFrame>
  );
}
