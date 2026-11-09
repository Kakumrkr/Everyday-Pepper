import type { Metadata } from 'next';
import { PRIVACY } from '../../../lib/legal';
import { LegalPage } from '../../_components/legal/legal-page';

export const metadata: Metadata = {
  title: 'Privacy policy · Pepper',
  description: PRIVACY.summary,
};

/** The privacy policy (S59.5, AC-X-54); `#ai` is where the emails' disclosure lands (AC-X-56). */
export default function PrivacyPage() {
  return <LegalPage document={PRIVACY} />;
}
