import {
  DEFAULT_REMINDER_SETTINGS,
  type ConfirmCutoffHours,
  type ServiceInput,
  type UserId,
  type WeeklyHoursInput,
} from '@pepper/contracts';
import type { Actor } from '@pepper/core';
import { setReminderSettings, type TenantTx } from '@pepper/db';
import { replaceWorkingHoursIn } from './hours.js';
import { createServiceIn } from './services.js';
import { createStaffMemberIn } from './staff.js';

// A new business's first week (S45, ADR-0046): its type's starting menu, the owner as the
// first staff member offering all of it, and the type's opening hours as that staff member's
// week. Written in the business's creation transaction, as the owner, through the same
// functions and audit entries as the screens, so everything stays editable. The type's confirm
// cut-off (S78.3, AC-X-217) is written as the business's own setting, every other reminder
// setting at its default: a pre-fill like the hours, so a later change to the template never
// moves the time a business's clients were told to confirm by.

/** One service of the starting menu; `rebookAfterDays`: when a regular is due again. */
export interface SeedService {
  service: ServiceInput;
  rebookAfterDays: number | null;
}

export interface BusinessSeed {
  services: readonly SeedService[];
  /** The owner's staff entry: their login and the name the booking page shows. */
  owner: { userId: UserId; displayName: string };
  hours: WeeklyHoursInput;
  /** The type's confirm cut-off (S78.3). */
  reminders: { confirmCutoffHours: ConfirmCutoffHours };
}

/** What `seedBusinessIn` created. */
export interface SeededBusiness {
  serviceCount: number;
  staffMemberId: string;
}

/** Writes `seed` in the caller's (new business's) transaction. `actor` is its owner. */
export async function seedBusinessIn(
  tx: TenantTx,
  actor: Actor,
  seed: BusinessSeed,
): Promise<SeededBusiness> {
  const serviceIds = [];
  for (const { service, rebookAfterDays } of seed.services) {
    serviceIds.push((await createServiceIn(tx, actor, service, { rebookAfterDays })).id);
  }
  const staff = await createStaffMemberIn(tx, actor, {
    displayName: seed.owner.displayName,
    userId: seed.owner.userId,
    serviceIds,
  });
  await replaceWorkingHoursIn(tx, actor, staff.id, seed.hours);
  await setReminderSettings(tx, {
    ...DEFAULT_REMINDER_SETTINGS,
    confirmCutoffHours: seed.reminders.confirmCutoffHours,
  });
  return { serviceCount: serviceIds.length, staffMemberId: staff.id };
}
