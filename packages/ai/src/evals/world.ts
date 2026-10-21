import {
  createBooking,
  createService,
  createStaffMember,
  replaceWorkingHours,
} from '@pepper/appointments';
import {
  addDays,
  formatDate,
  fromZoned,
  isoWeekday,
  TenantIdSchema,
  toZoned,
  type MembershipRole,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import { createBusiness, createClient, ManualClock, type Actor } from '@pepper/core';
import { addMembership, insertSeedUser, withTenant, type Database } from '@pepper/db';
import { z } from 'zod';

// Seeded eval worlds (ADR-0030, playbook §5): a real business in Postgres for each run of a
// case, so the loop's tool calls hit the real domain and the final state can be judged. The
// records get new ids every run; cassettes name them with placeholders (`{{client:maria}}`),
// filled in when a scripted answer is replayed and put back before a request is fingerprinted,
// so a recorded cassette stays valid across runs.

export const EvalWorldNameSchema = z.enum(['juniper']);
export type EvalWorldName = z.infer<typeof EvalWorldNameSchema>;

export interface EvalWorld {
  name: EvalWorldName;
  db: Database;
  tenantId: TenantId;
  timeZone: string;
  clock: ManualClock;
  /** The member a case runs as: the owner, the manager, or Jess (staff, her own staff member). */
  actorFor(role: MembershipRole): Actor;
  firstNameOf(role: MembershipRole): string;
  /** `{{kind:name}}` → id, for every seeded record a cassette may name. */
  placeholders: ReadonlyMap<string, string>;
}

let seeded = 0;

/**
 * Juniper Hair Studio at `now` in `timeZone`: Lena (owner), Cara (manager), Jess (staff, her
 * own staff member) and Marco (staff member, no login). Haircut (60 min + 10 clean-up) and
 * Colour (90 min); both cut, Jess also colours; both work Mon–Fri 09:00–17:00 and Marco
 * Saturdays 10:00–16:00. Clients Maria Lopez, Sara Kim, Sarah Park and Ana Ruiz. Maria is
 * booked with Jess at 15:00 on the next weekday; Ana at 14:00 on the next Friday.
 */
export async function seedEvalWorld(
  db: Database,
  name: EvalWorldName,
  at: { now: Date; timeZone: string },
): Promise<EvalWorld> {
  seeded += 1;
  const clock = new ManualClock(at.now);
  const ownerId = await insertSeedUser(db, 'Lena');
  const tenant = await createBusiness(db, ownerId, {
    name: 'Juniper Hair Studio',
    slug: `eval-${name}-${String(seeded)}-${String(at.now.getTime() % 1_000_000)}`,
    timeZone: at.timeZone,
  });
  const tenantId = TenantIdSchema.parse(tenant.id);
  const managerId = await insertSeedUser(db, 'Cara');
  const jessId = await insertSeedUser(db, 'Jess');
  await withTenant(db, tenantId, async (tx) => {
    await addMembership(tx, { userId: managerId, role: 'manager' });
    await addMembership(tx, { userId: jessId, role: 'staff' });
  });
  const members: Record<MembershipRole, { userId: UserId; firstName: string }> = {
    owner: { userId: ownerId, firstName: 'Lena' },
    manager: { userId: managerId, firstName: 'Cara' },
    staff: { userId: jessId, firstName: 'Jess' },
  };
  const actorFor = (role: MembershipRole): Actor => ({
    context: { tenantId, userId: members[role].userId, role },
    requestId: `eval-${role}-${String(seeded)}`,
  });
  const owner = actorFor('owner');

  const haircut = await createService(db, owner, {
    name: 'Haircut',
    durationMinutes: 60,
    bufferAfterMinutes: 10,
  });
  const colour = await createService(db, owner, { name: 'Colour', durationMinutes: 90 });
  const jess = await createStaffMember(db, owner, {
    displayName: 'Jess',
    userId: jessId,
    serviceIds: [haircut.id, colour.id],
  });
  const marco = await createStaffMember(db, owner, {
    displayName: 'Marco',
    serviceIds: [haircut.id],
  });
  const weekdays = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '17:00' }));
  await replaceWorkingHours(db, owner, jess.id, { intervals: weekdays });
  await replaceWorkingHours(db, owner, marco.id, {
    intervals: [...weekdays, { weekday: 6, start: '10:00', end: '16:00' }],
  });
  const maria = await createClient(db, owner, {
    name: 'Maria Lopez',
    email: 'maria.lopez@example.test',
    phone: '+12125550143',
  });
  const sara = await createClient(db, owner, { name: 'Sara Kim', email: 'sara@example.test' });
  const sarah = await createClient(db, owner, { name: 'Sarah Park' });
  const ana = await createClient(db, owner, { name: 'Ana Ruiz', email: 'ana@example.test' });

  const today = toZoned(at.timeZone, at.now.getTime());
  const after = (test: (weekday: number) => boolean) => {
    for (let offset = 1; offset <= 7; offset += 1) {
      const date = addDays(today, offset);
      if (test(isoWeekday(date))) return date;
    }
    throw new Error('no such day this week');
  };
  const at_ = (date: ReturnType<typeof addDays>, hour: number) =>
    new Date(fromZoned(at.timeZone, date, hour * 60)).toISOString();
  const book = (clientId: string, startsAt: string) =>
    createBooking(
      db,
      owner,
      {
        clientId: clientId as typeof maria.id,
        serviceId: haircut.id,
        staffMemberId: jess.id,
        startsAt,
        notifyClient: false,
      },
      { clock },
    );
  const mariaBooking = await book(
    maria.id,
    at_(
      after((day) => day <= 5),
      15,
    ),
  );
  const anaBooking = await book(
    ana.id,
    at_(
      after((day) => day === 5),
      14,
    ),
  );

  return {
    name,
    db,
    tenantId,
    timeZone: at.timeZone,
    clock,
    actorFor,
    firstNameOf: (role) => members[role].firstName,
    placeholders: new Map<string, string>([
      ['{{service:haircut}}', haircut.id],
      ['{{service:colour}}', colour.id],
      ['{{staff:jess}}', jess.id],
      ['{{staff:marco}}', marco.id],
      ['{{client:maria}}', maria.id],
      ['{{client:sara}}', sara.id],
      ['{{client:sarah}}', sarah.id],
      ['{{client:ana}}', ana.id],
      ['{{booking:maria}}', mariaBooking.id],
      ['{{booking:ana}}', anaBooking.id],
    ]),
  };
}

/** `text` with every placeholder replaced by its id. */
export function fillPlaceholders(text: string, placeholders: ReadonlyMap<string, string>): string {
  let filled = text;
  for (const [placeholder, id] of placeholders) filled = filled.replaceAll(placeholder, id);
  return filled;
}

/** `text` with every seeded id put back as its placeholder (for fingerprints and recordings). */
export function unfillPlaceholders(
  text: string,
  placeholders: ReadonlyMap<string, string>,
): string {
  let unfilled = text;
  for (const [placeholder, id] of placeholders) unfilled = unfilled.replaceAll(id, placeholder);
  return unfilled;
}
