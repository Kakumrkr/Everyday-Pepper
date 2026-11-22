import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ROUTES } from '../../../../lib/account';
import { paymentsArrival } from '../../../../lib/payments';
import { PaymentsPanel } from '../../../_components/payments/payments-panel';
import { currentAccount, currentBusiness, currentPayments } from '../../../_server/account';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Payments · Pepper' };

/**
 * More → Payments (S65.2, AC-X-106…109, ADR-0067): the business's Stripe account in words.
 * Owners and managers read it (`payments.read`), the owner acts on it (the api says so in
 * `canManage`); staff, and everyone while payments are off in the deployment, go back to More.
 * Stripe's return and refresh pages are this page with `?stripe=return|refresh`.
 */
export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const account = await currentAccount();
  if (account.state !== 'signed-in') return null;
  const current = await currentBusiness();
  if (current?.permissions.includes('payments.read') !== true) redirect(ROUTES.more);
  const [payments, params] = await Promise.all([currentPayments(), searchParams]);
  if (payments.state === 'off') redirect(ROUTES.more);

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6 pb-24 desk:pb-0">
      <header className="flex flex-col gap-1">
        <h1 className="m-0 type-display">Payments</h1>
        <p className="m-0 type-body text-ink-2">
          How {current.business.name} takes deposits, through Stripe.
        </p>
      </header>
      {payments.state === 'unavailable' ? (
        <p role="alert" className="m-0 rounded-md bg-warn-soft px-4 py-3 type-label text-warn">
          I couldn’t load payments. Try again in a moment.
        </p>
      ) : (
        <PaymentsPanel
          initial={payments.account}
          timeZone={current.business.timeZone}
          arrival={paymentsArrival(params)}
        />
      )}
    </div>
  );
}
