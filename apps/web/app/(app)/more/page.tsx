import {
  DeletionStatusSchema,
  FeedResponseSchema,
  ReminderSettingsViewSchema,
} from '@pepper/contracts';
import { Badge, buttonStyle, Icon, List, ListRow } from '@pepper/ui';
import Link from 'next/link';
import { ROUTES } from '../../../lib/account';
import {
  ACCOUNT_DELETION_PATH,
  BUSINESS_DELETION_PATH,
  deletionDayLabel,
} from '../../../lib/deletion';
import { TextLink } from '../../_components/auth-page';
import { appNav, type NavItem } from '../../../lib/nav';
import { HELP_PATH } from '../../../lib/help';
import { REMINDER_SETTINGS_PATH, remindersSummary } from '../../../lib/reminder-settings';
import { PRIVACY_PATH } from '@pepper/contracts';
import { newRequestHref, SUPPORT_PATHS } from '../../../lib/support';
import { BusinessSwitcher, SignOutButton } from '../../_components/account-actions';
import { kitLink } from '../../_components/kit-link';
import { NotificationsCard } from '../../_components/push/notifications-card';
import { ReviewLinkSetting } from '../../_components/feed/review-link-setting';
import { MailingAddressSetting } from '../../_components/feed/mailing-address-setting';
import {
  currentAccount,
  currentBusiness,
  currentJson,
  currentSupportUnread,
} from '../../_server/account';

// Per request: the page depends on the session cookie.
export const dynamic = 'force-dynamic';

/**
 * More (S41, AC-X-5): on phones the places beyond the tabs (Pepper's group and the business's
 * setup), then the settings (this device's notifications, the rebooking emails' address) and the
 * account; on desktop the sidebar lists the places, so the page is "Settings" with the rest.
 */
export default async function MorePage() {
  // The app layout has sent anyone without a usable session elsewhere already.
  const account = await currentAccount();
  if (account.state !== 'signed-in') return null;
  const { me } = account;
  const current = await currentBusiness();
  const nav = appNav(current?.permissions ?? null);
  // The feed's settings carry the mailing address; owners and managers may change it.
  const feed =
    current?.permissions.includes('feed.read') === true
      ? await currentJson('/v1/feed', FeedResponseSchema)
      : null;
  // A business or an account being deleted says so here (S51.2, ADR-0054).
  // Texts and reminders (S62.2): whoever reads the calendar sees what clients get; read beside
  // the rest, so the row's line costs no extra wait.
  const readsCalendar = current?.permissions.includes('calendar.read') === true;
  const [businessDeletion, accountDeletion, support, reminders] = await Promise.all([
    current === null ? null : currentJson(BUSINESS_DELETION_PATH, DeletionStatusSchema),
    currentJson(ACCOUNT_DELETION_PATH, DeletionStatusSchema),
    current === null ? null : currentSupportUnread(),
    readsCalendar ? currentJson(REMINDER_SETTINGS_PATH, ReminderSettingsViewSchema) : null,
  ]);
  const unread = support ?? 0;
  const timeZone = current?.business.timeZone ?? 'UTC';
  const businessDueAt = businessDeletion?.dueAt ?? null;
  const accountDueAt = accountDeletion?.dueAt ?? null;

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
      {current === null || businessDueAt === null ? null : (
        <p
          className="m-0 rounded-md bg-info-soft px-4 py-3 type-body text-ink"
          data-testid="business-deletion-notice"
        >
          Pepper deletes {current.business.name} on{' '}
          <span className="font-semibold">{deletionDayLabel(businessDueAt, timeZone)}</span>.
          {current.permissions.includes('business.delete') ? (
            <>
              {' '}
              <TextLink href={ROUTES.deleteBusiness}>Keep it</TextLink>
            </>
          ) : (
            ' Its booking page is closed until then.'
          )}
        </p>
      )}
      <Places title="Pepper" items={nav.pepper} />
      <Places title="Business" items={nav.business} />
      <section aria-labelledby="more-help">
        <h2 id="more-help" className="m-0 mb-1 type-heading">
          Help
        </h2>
        <List>
          <ListRow
            title={<HelpTitle icon="help">Help centre</HelpTitle>}
            meta="Short answers to the common questions"
            href={HELP_PATH}
            renderLink={kitLink}
          />
          <ListRow
            title={<HelpTitle icon="lock">Privacy and terms</HelpTitle>}
            meta="What Pepper keeps, what its AI does, and your rights"
            href={PRIVACY_PATH}
            renderLink={kitLink}
          />
          {current === null ? null : (
            <>
              <ListRow
                title={<HelpTitle icon="chat">Tell us what went wrong</HelpTitle>}
                meta="A person answers the same day"
                href={newRequestHref({ page: ROUTES.more })}
                renderLink={kitLink}
              />
              <ListRow
                title={<HelpTitle icon="activity">Your requests</HelpTitle>}
                trailing={
                  unread > 0 ? (
                    <Badge tone="brand">
                      {unread === 1 ? '1 new answer' : `${String(unread)} new answers`}
                    </Badge>
                  ) : undefined
                }
                href={SUPPORT_PATHS.list}
                renderLink={kitLink}
              />
            </>
          )}
        </List>
      </section>
      {readsCalendar ? (
        <section aria-labelledby="more-clients">
          <h2 id="more-clients" className="m-0 mb-1 type-heading">
            Your clients
          </h2>
          <List>
            <ListRow
              title={<HelpTitle icon="chat">Texts and reminders</HelpTitle>}
              meta={
                reminders === null
                  ? 'What clients get before a visit'
                  : remindersSummary(reminders.settings)
              }
              href={ROUTES.textsAndReminders}
              renderLink={kitLink}
            />
          </List>
        </section>
      ) : null}
      {current === null ? null : <NotificationsCard />}
      {feed?.canChangeSettings === true ? (
        <section aria-labelledby="rebooking-heading" className="flex flex-col gap-3">
          <h2 id="rebooking-heading" className="m-0 type-subheading">
            Emails to clients
          </h2>
          <MailingAddressSetting address={feed.mailingAddress} />
          <ReviewLinkSetting url={feed.reviewUrl} addressSet={feed.mailingAddress !== null} />
        </section>
      ) : null}
      <section aria-labelledby="account-heading" className="flex flex-col items-start gap-4">
        <h2 id="account-heading" className="m-0 type-heading">
          Account
        </h2>
        <p className="m-0 type-body text-ink-2">
          Signed in as <span className="font-semibold break-all text-ink">{me.user.email}</span>
        </p>
        <Link href={ROUTES.changeEmail} className={buttonStyle({ variant: 'secondary' })}>
          Change email
        </Link>
        {current?.permissions.includes('business.export') === true ? (
          <Link href={ROUTES.yourData} className={buttonStyle({ variant: 'secondary' })}>
            Download your data
          </Link>
        ) : null}
        {me.businesses.length > 1 || current === null ? (
          <div className="w-full">
            <BusinessSwitcher businesses={me.businesses} activeTenantId={me.activeTenantId} />
          </div>
        ) : null}
        <SignOutButton />
        {accountDueAt === null ? (
          <Link href={ROUTES.deleteAccount} className={buttonStyle({ variant: 'quiet' })}>
            Delete your account
          </Link>
        ) : (
          <p className="m-0 type-body text-ink" data-testid="account-deletion-notice">
            Your account is deleted on{' '}
            <span className="font-semibold">{deletionDayLabel(accountDueAt, timeZone)}</span>.{' '}
            <TextLink href={ROUTES.deleteAccount}>Keep my account</TextLink>
          </p>
        )}
      </section>
    </div>
  );
}

function HelpTitle({
  icon,
  children,
}: {
  icon: 'help' | 'chat' | 'activity' | 'lock';
  children: string;
}) {
  return (
    <span className="flex items-center gap-3">
      <Icon name={icon} className="shrink-0 text-brand" />
      {children}
    </span>
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
            title={
              <span className="flex items-center gap-3">
                <Icon name={item.icon} className="shrink-0 text-brand" />
                {item.label}
              </span>
            }
            href={item.href}
            renderLink={kitLink}
          />
        ))}
      </List>
    </section>
  );
}
