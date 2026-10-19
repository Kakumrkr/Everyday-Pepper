import { BookingRulesResponseSchema } from '@pepper/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ROUTES } from '../../../../lib/account';
import { defaultsLabel } from '../../../../lib/setup';
import { RulesEditor } from '../../../_components/setup/rules-editor';
import { currentAccount, currentBusiness, currentJson } from '../../../_server/account';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Booking rules · Pepper' };

/**
 * The business's booking rules (S16, ADR-0016): everyone may read them, owners and managers
 * change them. Values left on the default follow the industry template, else Pepper's.
 */
export default async function RulesPage() {
  const account = await currentAccount();
  if (account.state !== 'signed-in') return null;
  const current = await currentBusiness();
  if (!current?.permissions.includes('rules.read')) redirect(ROUTES.home);

  const answer = await currentJson('/v1/rules', BookingRulesResponseSchema);

  return (
    <div className="mx-auto max-w-2xl">
      <p className="m-0 mb-1">
        <Link href={ROUTES.services}>Services</Link>
      </p>
      <header className="mb-5">
        <h1 className="m-0 font-display text-2xl font-bold">Booking rules</h1>
        {answer === null ? null : (
          <p className="m-0 text-ink-2">
            Unless you change them: {defaultsLabel(answer.defaults)}.
          </p>
        )}
      </header>
      {answer === null ? (
        <p role="alert" className="rounded-md bg-wait-soft px-4 py-3 font-semibold text-wait">
          I couldn’t load your booking rules. Try again in a moment.
        </p>
      ) : (
        <RulesEditor
          rules={answer.rules}
          defaults={answer.defaults}
          manages={current.permissions.includes('rules.manage')}
          ownRules={answer.rules.filter((rule) => rule.staffMemberId !== null).length}
        />
      )}
    </div>
  );
}
