import { randomBytes } from 'node:crypto';
import {
  addTimeOff,
  addToWaitlist,
  createBooking,
  createService,
  createStaffMember,
  replaceWorkingHours,
} from '@pepper/appointments';
import {
  addDays,
  ClientIdSchema,
  fromZoned,
  isoWeekday,
  LLM_EMBED_BATCH_MAX,
  MemoryFactIdSchema,
  MemorySubjectSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  TenantIdSchema,
  type MemorySubject,
  toZoned,
  type MembershipRole,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import {
  changeFeedSettings,
  changeMemorySettings,
  createBusiness,
  createClient,
  createTask,
  ManualClock,
  saveEpisode,
  saveFact,
  type Actor,
} from '@pepper/core';
import {
  addMembership,
  findClient,
  insertSeedUser,
  optOutClientEmail,
  updateClient,
  withTenant,
  type Database,
} from '@pepper/db';
import { z } from 'zod';
import type { Embedder } from '../embedder.js';

// Seeded eval worlds (ADR-0030, playbook §5): a real business in Postgres for each run of a
// case, so the loop's tool calls hit the real domain and the final state can be judged. The
// records get new ids every run; cassettes name them with placeholders (`{{client:maria}}`),
// filled in when a scripted answer is replayed and put back before a request is fingerprinted,
// so a recorded cassette stays valid across runs.

export const EvalWorldNameSchema = z.enum(['juniper', 'juniper_memory', 'juniper_feed']);
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

/** Every placeholder a seeded world fills in (cassettes and case expectations name them). */
export const WORLD_PLACEHOLDERS = [
  '{{service:haircut}}',
  '{{service:colour}}',
  '{{staff:jess}}',
  '{{staff:marco}}',
  '{{client:maria}}',
  '{{client:sara}}',
  '{{client:sarah}}',
  '{{client:ana}}',
  '{{booking:maria}}',
  '{{booking:ana}}',
  '{{todo:call-maria}}',
  '{{timeoff:jess-lunch}}',
] as const;

/** What `juniper_memory` adds (S30): Maria's last colour visit, two weeks back. */
export const MEMORY_WORLD_PLACEHOLDERS = ['{{booking:maria-last}}'] as const;

/** What `juniper_feed` adds (S36): Sara's last haircut, five weeks back. */
export const FEED_WORLD_PLACEHOLDERS = ['{{booking:sara-last}}'] as const;

/**
 * What a case seeds besides the world (S30): remembered facts, past conversations' summaries
 * (S31, embedded by the run's embedder), and the pause switch.
 */
export interface WorldSeed {
  facts: readonly {
    name: string;
    subject: string;
    key: string;
    value: string;
    sensitive?: boolean | undefined;
  }[];
  episodes?: readonly {
    name: string;
    member: MembershipRole;
    summary: string;
    daysAgo: number;
    facts: readonly string[];
    clients: readonly string[];
  }[];
  memoryPaused: boolean;
  /**
   * The feed's world (S36, `juniper_feed`): clients who unsubscribed from marketing email, and
   * whether the business has a mailing address (it has one unless `false`).
   */
  feed?:
    | {
        optedOut: readonly string[];
        mailingAddress: boolean;
        /** "Pause suggestions" is on. */
        paused?: boolean;
        /** Clients' names as they typed them on the booking page (untrusted text). */
        clientNames?: Readonly<Record<string, string>>;
      }
    | undefined;
  /** Clients waiting before the case starts (S37). */
  waitlist?: readonly {
    client: string;
    service: string;
    staff: string | null;
    windows: readonly { date: string; start: string; end: string }[];
  }[];
}

/** Where `juniper_feed`'s rebooking emails say the business is. */
export const EVAL_MAILING_ADDRESS = '12 Juniper Lane\nPortland, OR 97201';

let seeded = 0;
/** Tells this process's worlds from an earlier run's in a database the runs share. */
const RUN = randomBytes(3).toString('hex');

/**
 * Juniper Hair Studio at `now` in `timeZone` (`juniper_memory`: Colour is in the Color
 * category, and Maria had a colour with Jess on a weekday about two weeks back, S30; a case's
 * seeded facts are remembered as the owner said them on a screen, named `{{fact:<name>}}`): Lena (owner), Cara (manager), Jess (staff, her
 * own staff member) and Marco (staff member, no login). Haircut (60 min + 10 clean-up) and
 * Colour (90 min); both cut, Jess also colours; both work Mon–Fri 09:00–17:00 and Marco
 * Saturdays 10:00–16:00. Clients Maria Lopez, Sara Kim, Sarah Park and Ana Ruiz. Maria is
 * booked with Jess at 15:00 on the next weekday; Ana at 14:00 on the next Friday. Lena has an
 * open to-do "Call Maria about her colour", and Jess's lunch is blocked 12:00–13:00 on the
 * next weekday (S26b).
 */
export async function seedEvalWorld(
  db: Database,
  name: EvalWorldName,
  at: { now: Date; timeZone: string },
  seed: WorldSeed = { facts: [], memoryPaused: false },
  options: { embedder?: Embedder } = {},
): Promise<EvalWorld> {
  // Numbered before the first await: worlds seeded at the same time must not share a slug.
  seeded += 1;
  const number = seeded;
  const clock = new ManualClock(at.now);
  const ownerId = await insertSeedUser(db, 'Lena');
  const tenant = await createBusiness(db, ownerId, {
    name: 'Juniper Hair Studio',
    slug: `eval-${name.replaceAll('_', '-')}-${RUN}-${String(number)}-${String(at.now.getTime() % 1_000_000)}`,
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
    requestId: `eval-${role}-${String(number)}`,
  });
  const owner = actorFor('owner');

  const haircut = await createService(db, owner, {
    name: 'Haircut',
    durationMinutes: 60,
    bufferAfterMinutes: 10,
  });
  const colour = await createService(db, owner, {
    name: 'Colour',
    durationMinutes: 90,
    ...(name === 'juniper_memory' && { category: 'Color' }),
  });
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
  const book = (clientId: typeof maria.id, startsAt: string) =>
    createBooking(
      db,
      owner,
      {
        clientId,
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

  const todo = await createTask(db, owner, { title: 'Call Maria about her colour' });
  const lunch = await addTimeOff(db, owner, jess.id, {
    startsAt: at_(
      after((day) => day <= 5),
      12,
    ),
    endsAt: at_(
      after((day) => day <= 5),
      13,
    ),
  });

  const placeholders = new Map<string, string>([
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
    ['{{todo:call-maria}}', todo.id],
    ['{{timeoff:jess-lunch}}', lunch.id],
  ]);

  if (name === 'juniper_memory') {
    // A weekday 10 to 16 days back, at 10:00, booked back then (bookings can't start in the past).
    let past = addDays(today, -10);
    while (isoWeekday(past) > 5) past = addDays(past, -1);
    const then = new ManualClock(new Date(Date.parse(at_(past, 10)) - 7 * 86_400_000));
    const last = await createBooking(
      db,
      owner,
      {
        clientId: maria.id,
        serviceId: colour.id,
        staffMemberId: jess.id,
        startsAt: at_(past, 10),
        notifyClient: false,
      },
      { clock: then },
    );
    placeholders.set('{{booking:maria-last}}', last.id);
  }
  if (name === 'juniper_feed') {
    // Regulars (S36): Sara (with an email) and Sarah (without) each had three haircuts with
    // Jess four weeks apart, the last five weeks ago, so both are a week overdue; nothing is
    // booked for them.
    const visits: [typeof sara.id, number][] = [
      [sara.id, -91],
      [sara.id, -63],
      [sara.id, -35],
      [sarah.id, -90],
      [sarah.id, -62],
      [sarah.id, -34],
    ];
    for (const [clientId, offset] of visits) {
      let date = addDays(today, offset);
      while (isoWeekday(date) > 5) date = addDays(date, -1);
      const startsAt = at_(date, 10);
      const visit = await createBooking(
        db,
        owner,
        { clientId, serviceId: haircut.id, staffMemberId: jess.id, startsAt, notifyClient: false },
        { clock: new ManualClock(new Date(Date.parse(startsAt) - 7 * 86_400_000)) },
      );
      if (clientId === sara.id) placeholders.set('{{booking:sara-last}}', visit.id);
    }
    if (seed.feed?.mailingAddress !== false) {
      await changeFeedSettings(db, owner, { mailingAddress: EVAL_MAILING_ADDRESS });
    }
    for (const ref of seed.feed?.optedOut ?? []) {
      const clientId = ClientIdSchema.parse(placeholders.get(ref));
      await withTenant(db, tenantId, (tx) => optOutClientEmail(tx, clientId, at.now));
    }
    for (const [ref, typed] of Object.entries(seed.feed?.clientNames ?? {})) {
      const clientId = ClientIdSchema.parse(placeholders.get(ref));
      await withTenant(db, tenantId, async (tx) => {
        const client = await findClient(tx, clientId);
        if (client === undefined) throw new Error(`No seeded record ${ref}`);
        await updateClient(tx, clientId, { name: typed, email: client.email, phone: client.phone });
      });
    }
    if (seed.feed?.paused === true) {
      await changeFeedSettings(db, owner, { suggestionsPaused: true });
    }
  }
  for (const waiting of seed.waitlist ?? []) {
    const ref = (key: string) => {
      const value = placeholders.get(key);
      if (value === undefined) throw new Error(`No seeded record ${key}`);
      return value;
    };
    await addToWaitlist(
      db,
      owner,
      {
        clientId: ClientIdSchema.parse(ref(waiting.client)),
        serviceId: ServiceIdSchema.parse(ref(waiting.service)),
        staffMemberId:
          waiting.staff === null ? null : StaffMemberIdSchema.parse(ref(waiting.staff)),
        windows: waiting.windows.map((w) => ({ ...w })),
      },
      { clock },
    );
  }
  for (const fact of seed.facts) {
    const { fact: saved } = await saveFact(db, owner, {
      subject: subjectOf(fact.subject, placeholders),
      key: fact.key,
      value: fact.value,
      ...(fact.sensitive !== undefined && { sensitive: fact.sensitive }),
    });
    placeholders.set(`{{fact:${fact.name}}}`, saved.id);
  }
  const episodes = seed.episodes ?? [];
  if (episodes.length > 0) {
    const { embedder } = options;
    if (embedder === undefined) throw new Error('Seeding episodes needs an embedder');
    const embeddings: number[][] = [];
    for (let from = 0; from < episodes.length; from += LLM_EMBED_BATCH_MAX) {
      const batch = episodes.slice(from, from + LLM_EMBED_BATCH_MAX);
      embeddings.push(
        ...(await embedder.embed({ input: batch.map((each) => each.summary) })).embeddings,
      );
    }
    for (const [index, episode] of episodes.entries()) {
      const idOf = (ref: string) => {
        const id = placeholders.get(ref);
        if (id === undefined) throw new Error(`No seeded record ${ref}`);
        return id;
      };
      const saved = await saveEpisode(
        db,
        actorFor(episode.member).context,
        {
          conversationId: null,
          summary: episode.summary,
          clientIds: episode.clients.map((ref) => ClientIdSchema.parse(idOf(ref))),
          factIds: episode.facts.map((ref) => MemoryFactIdSchema.parse(idOf(ref))),
          embedding: embeddings[index] ?? [],
          embeddingModel: embedder.model,
        },
        { clock: new ManualClock(new Date(at.now.getTime() - episode.daysAgo * 86_400_000)) },
      );
      placeholders.set(`{{episode:${episode.name}}}`, saved.id);
    }
  }
  if (seed.memoryPaused) await changeMemorySettings(db, owner, { paused: true });

  return {
    name,
    db,
    tenantId,
    timeZone: at.timeZone,
    clock,
    actorFor,
    firstNameOf: (role) => members[role].firstName,
    placeholders,
  };
}

/** A case's subject (`business`, `{{client:maria}}`…) as the memory services name it. */
export function subjectOf(ref: string, placeholders: ReadonlyMap<string, string>): MemorySubject {
  if (ref === 'business') return { type: 'business' };
  const kind = /^\{\{(client|staff|service|booking):/.exec(ref)?.[1];
  const id = placeholders.get(ref);
  if (kind === undefined || id === undefined) throw new Error(`No seeded record ${ref}`);
  return MemorySubjectSchema.parse({ type: kind, id });
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
