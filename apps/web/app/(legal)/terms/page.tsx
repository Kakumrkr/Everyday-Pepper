import type { Metadata } from 'next';
import { TERMS } from '../../../lib/legal';
import { LegalPage } from '../../_components/legal/legal-page';

export const metadata: Metadata = {
  title: 'Terms of service · Pepper',
  description: TERMS.summary,
};

/** The terms of service (S59.5, AC-X-54). */
export default function TermsPage() {
  return <LegalPage document={TERMS} />;
}
