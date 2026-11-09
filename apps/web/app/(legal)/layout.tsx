import type { ReactNode } from 'react';
import { HELP_PATH } from '../../lib/help';
import { PublicFrame } from '../_components/public-frame';

/** The policies' frame (S59.5, AC-X-54): the help centre's, so both read as one place. */
export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <PublicFrame home={HELP_PATH} homeLabel="Pepper help centre">
      {children}
    </PublicFrame>
  );
}
