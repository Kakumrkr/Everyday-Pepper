import { redirect } from 'next/navigation';
import Link from 'next/link';
import { requiredStep, ROUTES } from '../lib/account';
import { currentAccount, currentBusiness } from './_server/account';
import { BusinessSwitcher, SignOutButton } from './_components/account-actions';
import { Unavailable } from './_components/unavailable';

// Per request: the page depends on the session cookie.
export const dynamic = 'force-dynamic';

/** Signed-in home. Phase 4 replaces the body with the operator feed. */
export default async function HomePage() {
  const account = await currentAccount();
  const step = requiredStep(account);
  if (step !== null) redirect(step);
  if (account.state !== 'signed-in') return <Unavailable />;

  const { me } = account;
  const current = await currentBusiness();
  return (
    <main>
      <h1 className="wordmark">floty</h1>
      <p className="tagline">Hi {me.user.name}, your AI employee is getting ready.</p>
      {current === null ? (
        <p className="status">Choose a business below.</p>
      ) : (
        <p className="status" data-state="ok" data-testid="current-business">
          <span data-testid="business-name">{current.business.name}</span>
          <span data-testid="business-role">{current.role}</span>
        </p>
      )}
      {me.businesses.length > 1 || current === null ? (
        <BusinessSwitcher businesses={me.businesses} activeTenantId={me.activeTenantId} />
      ) : null}
      <div className="actions">
        {current === null ? null : <Link href={ROUTES.team}>Team</Link>}
        <SignOutButton />
      </div>
    </main>
  );
}
