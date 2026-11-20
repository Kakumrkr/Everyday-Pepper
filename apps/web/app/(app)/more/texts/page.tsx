import { MemberTextsSchema, ReminderSettingsViewSchema } from '@pepper/contracts';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ROUTES } from '../../../../lib/account';
import { MEMBER_TEXTS_PATH } from '../../../../lib/member-texts';
import { REMINDER_SETTINGS_PATH } from '../../../../lib/reminder-settings';
import { CardTextsSection } from '../../../_components/reminders/card-texts-section';
import { ReminderSettingsForm } from '../../../_components/reminders/reminder-settings-form';
import { currentAccount, currentBusiness, currentJson } from '../../../_server/account';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Texts and reminders · Pepper' };

/**
 * Texts and reminders (S62.2, AC-X-77, ADR-0065): whether clients get texts, the day-before
 * reminder, the same-day text and its lead. Everyone who reads the calendar sees them; owners
 * and managers change them (the api decides, and says so in `canChange`). Below, for owners and
 * managers only, "Cards to your phone": their own checked number and "Text me cards" (S63.2,
 * AC-X-88/89, ADR-0066); staff get no cards by text, so they don't see it.
 */
export default async function TextsAndRemindersPage() {
  const account = await currentAccount();
  if (account.state !== 'signed-in') return null;
  const current = await currentBusiness();
  if (current?.permissions.includes('calendar.read') !== true) redirect(ROUTES.more);
  const [view, mine] = await Promise.all([
    currentJson(REMINDER_SETTINGS_PATH, ReminderSettingsViewSchema),
    currentJson(MEMBER_TEXTS_PATH, MemberTextsSchema),
  ]);

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6 pb-24 desk:pb-0">
      <header className="flex flex-col gap-1">
        <h1 className="m-0 type-display">Texts and reminders</h1>
        <p className="m-0 type-body text-ink-2">
          What clients of {current.business.name} hear from you before a visit. Clients who reply C
          to a reminder show as confirmed on your calendar.
        </p>
      </header>
      {view === null ? (
        <p role="alert" className="m-0 rounded-md bg-warn-soft px-4 py-3 type-label text-warn">
          I couldn’t load these settings. Try again in a moment.
        </p>
      ) : (
        <ReminderSettingsForm initial={view} />
      )}
      {mine?.canTextCards === true ? (
        <CardTextsSection initial={mine} businessName={current.business.name} />
      ) : null}
    </div>
  );
}
