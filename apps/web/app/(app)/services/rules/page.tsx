import { BookingRulesResponseSchema } from '@pepper/contracts';
import { buttonStyle, cx, Icon } from '@pepper/ui';
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
 * change them. Values left on the default follow the industry template, else Pepper's. On the
 * kit since S42.2.
 */
export default async function RulesPage() {
  const account = await currentAccount();
  if (account.state !== 'signed-in') return null;
  const current = await currentBusiness();
  if (!current?.permissions.includes('rules.read')) redirect(ROUTES.home);

  const answer = await currentJson('/v1/rules', BookingRulesResponseSchema);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
      <Link
        href={ROUTES.services}
        className={cx(buttonStyle({ variant: 'quiet', size: 'sm' }), '-ml-3 self-start')}
      >
        <Icon name="left" />
        Services
      </Link>
      <header className="flex flex-col gap-1">
        <h1 className="m-0 type-display">Booking rules</h1>
        {answer === null ? null : (
          <p className="m-0 type-body text-ink-2">
            Unless you change them: {defaultsLabel(answer.defaults)}.
          </p>
        )}
      </header>
      {answer === null ? (
        <p role="alert" className="m-0 rounded-md bg-warn-soft px-4 py-3 type-label text-warn">
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
