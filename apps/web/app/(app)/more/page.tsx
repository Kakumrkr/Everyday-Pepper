import { Icon, List, ListRow } from '@pepper/ui';
import { appNav, type NavItem } from '../../../lib/nav';
import { BusinessSwitcher, SignOutButton } from '../../_components/account-actions';
import { kitLink } from '../../_components/kit-link';
import { NotificationsCard } from '../../_components/push/notifications-card';
import { currentAccount, currentBusiness } from '../../_server/account';

// Per request: the page depends on the session cookie.
export const dynamic = 'force-dynamic';

/**
 * More (S41, AC-X-5): on phones the places beyond the tabs (Pepper's group and the business's
 * setup), then this device's settings and the account; on desktop the sidebar lists the places,
 * so the page is "Settings" with only the last two.
 */
export default async function MorePage() {
  // The app layout has sent anyone without a usable session elsewhere already.
  const account = await currentAccount();
  if (account.state !== 'signed-in') return null;
  const { me } = account;
  const current = await currentBusiness();
  const nav = appNav(current?.permissions ?? null);

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="m-0 type-display">
          <span className="desk:hidden">More</span>
          <span className="hidden desk:inline">Settings</span>
        </h1>
        {current === null ? null : (
          <p className="m-0 type-body text-ink-2">
            {current.business.name} · <span className="capitalize">{current.role}</span>
          </p>
        )}
      </div>
      <Places title="Pepper" items={nav.pepper} />
      <Places title="Business" items={nav.business} />
      {current === null ? null : <NotificationsCard />}
      <section aria-labelledby="account-heading" className="flex flex-col items-start gap-4">
        <h2 id="account-heading" className="m-0 type-heading">
          Account
        </h2>
        <p className="m-0 type-body text-ink-2">
          Signed in as <span className="font-semibold break-all text-ink">{me.user.email}</span>
        </p>
        {me.businesses.length > 1 || current === null ? (
          <div className="w-full">
            <BusinessSwitcher businesses={me.businesses} activeTenantId={me.activeTenantId} />
          </div>
        ) : null}
        <SignOutButton />
      </section>
    </div>
  );
}

/** A group of places as hairline rows; phones only (the sidebar has them on desktop). */
function Places({ title, items }: { title: string; items: readonly NavItem[] }) {
  if (items.length === 0) return null;
  const headingId = `more-${title.toLowerCase()}`;
  return (
    <section aria-labelledby={headingId} className="desk:hidden">
      <h2 id={headingId} className="m-0 mb-1 type-heading">
        {title}
      </h2>
      <List>
        {items.map((item) => (
          <ListRow
            key={item.key}
            title={item.label}
            leading={<Icon name={item.icon} className="text-brand" />}
            href={item.href}
            renderLink={kitLink}
          />
        ))}
      </List>
    </section>
  );
}
