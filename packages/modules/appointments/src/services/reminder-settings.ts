import {
  ReminderSettingsPatchSchema,
  ReminderSettingsSchema,
  ReminderSettingsViewSchema,
  type ReminderSettingsPatch,
  type ReminderSettingsView,
} from '@pepper/contracts';
import {
  auditActorOf,
  can,
  requirePermission,
  systemClock,
  type Actor,
  type Clock,
} from '@pepper/core';
import {
  appendAuditEntry,
  findCurrentTenant,
  setReminderSettings,
  withTenant,
  type Database,
  type TenantTx,
} from '@pepper/db';
import { BookingNotFoundError } from '../errors.js';
import { withdrawReleaseCards, withdrawUnfitReleaseCards } from './release-check.js';
import { reminderSettingsOf, replanUpcomingReminders } from './reminders.js';

// Texts and reminders (S62, AC-X-75): every member sees what the business sends its clients;
// owners and managers change it (`settings.manage`, audited). A change re-plans the upcoming
// bookings' reminders in the same transaction, so a new lead or a kind turned on applies to
// visits already booked.

/** The business's reminder settings, and whether this member may change them. */
export async function getReminderSettings(
  db: Database,
  actor: Actor,
): Promise<ReminderSettingsView> {
  requirePermission(actor, 'calendar.read');
  return withTenant(db, actor.context.tenantId, async (tx) =>
    viewOf(actor, reminderSettingsOf(await currentTenant(tx))),
  );
}

/** Changes the fields `patch` names; the others stay. Answers the new settings. */
export async function updateReminderSettings(
  db: Database,
  actor: Actor,
  patch: ReminderSettingsPatch,
  options: { clock?: Clock } = {},
): Promise<ReminderSettingsView> {
  requirePermission(actor, 'settings.manage');
  const change = ReminderSettingsPatchSchema.parse(patch);
  const now = (options.clock ?? systemClock).now().getTime();
  return withTenant(db, actor.context.tenantId, async (tx) => {
    const tenant = await currentTenant(tx);
    const before = reminderSettingsOf(tenant);
    const after = ReminderSettingsSchema.parse({ ...before, ...change });
    if (JSON.stringify(before) === JSON.stringify(after)) return viewOf(actor, after);
    await setReminderSettings(tx, after);
    await appendAuditEntry(tx, {
      actor: auditActorOf(actor),
      change: {
        action: 'reminders.settings_updated',
        entity: { type: 'tenant', id: tenant.id },
        before,
        after,
      },
      requestId: actor.requestId,
    });
    await replanUpcomingReminders(tx, tenant.timeZone, after, now);
    // No longer asking: the release cards waiting could no longer be approved (S78.2).
    if (before.askToConfirm && !after.askToConfirm) await withdrawReleaseCards(tx, now);
    // A new cut-off: a card shown at the old one may not fit the new one yet (S78.3, AC-X-218).
    else if (before.confirmCutoffHours !== after.confirmCutoffHours) {
      await withdrawUnfitReleaseCards(tx, after, now);
    }
    return viewOf(actor, after);
  });
}

async function currentTenant(tx: TenantTx) {
  const tenant = await findCurrentTenant(tx);
  // The transaction's own business always exists.
  if (tenant === undefined) throw new BookingNotFoundError();
  return tenant;
}

function viewOf(
  actor: Actor,
  settings: ReturnType<typeof reminderSettingsOf>,
): ReminderSettingsView {
  return ReminderSettingsViewSchema.parse({
    settings,
    canChange: can(actor.context, 'settings.manage'),
  });
}
