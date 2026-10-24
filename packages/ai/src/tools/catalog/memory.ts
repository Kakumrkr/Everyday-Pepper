import { getBookingIn } from '@pepper/appointments';
import {
  BookingIdSchema,
  ClientIdSchema,
  ConversationTurnIdSchema,
  looksLikeContact,
  MEMORY_LIMITS,
  MemoryFactIdSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  type MemoryFact,
  type MemorySubject,
  type TrustJson,
} from '@pepper/contracts';
import {
  activateFactIn,
  discardProposedFactIn,
  forgetFactIn,
  forgetSavedFactIn,
  getFactIn,
  restoreFactIn,
  saveFactIn,
  subjectKey,
} from '@pepper/core';
import { z } from 'zod';
import { InvalidToolArgumentsError } from '../errors.js';
import { localOf } from '../local-time.js';
import type { Performed, ToolScope, WriteTool } from '../tool.js';
import { clientNames, day, directoryOf, IdArg, serviceName, staffName } from './shared.js';

// The memory tools (S30, ADR-0035, playbook principles 5–7): the AI remembers what a member
// says plainly about a client, a visit, a staff member, a service or the business, and forgets
// it when asked. A remembered value lives only in the memory tables: the call first stores it as
// a proposed fact (`stash`), and the proposal, the receipt and *Why?* hold that fact's id. The
// dial (`client_note.save`) then runs it or asks; after untrusted text it always asks (D-2).
// Forgetting always asks (D-1) and can't be undone: it removes the value everywhere.

const KeyArg = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,39}$/)
  .describe(
    'A short snake_case name for what it is: allergy, health, injury, pregnancy, usual_service, preference, formula, pressure, products, schedule… Reuse the key of a fact being updated',
  );

const ValueArg = z
  .string()
  .trim()
  .min(1)
  .max(MEMORY_LIMITS.valueMax)
  .refine((value) => !looksLikeContact(value), 'Keep contact details on the client record')
  .describe('What the member said, in their words, as short as it stays clear');

/** What a remembered fact is about, for the member: "Maria L.", "Jess", "the business". */
async function subjectLabel(scope: ToolScope, subject: MemorySubject): Promise<string> {
  switch (subject.type) {
    case 'business':
      return 'the business';
    case 'client':
      return (await clientNames(scope, [subject.id])).get(subject.id) ?? 'the client';
    case 'staff':
      return staffName(await directoryOf(scope), subject.id);
    case 'service':
      return serviceName(await directoryOf(scope), subject.id);
    case 'booking': {
      const booking = await getBookingIn(scope.tx, scope.actor, subject.id);
      const name = (await clientNames(scope, [booking.clientId])).get(booking.clientId);
      return `${name ?? 'the client'}'s visit on ${day(localOf(scope.timeZone, booking.startsAt).date)}`;
    }
  }
}

const words = (key: string) => key.replaceAll('_', ' ');

/** A fact as one side of the card: what it is about and its key, never its value. */
function factSide(fact: MemoryFact, about: string) {
  return { factId: fact.id, about, key: fact.key, sensitive: fact.sensitive };
}

/** What `remember_fact` and `add_visit_note` store with the action: the proposed fact's id. */
const SavePayload = z.strictObject({ factId: MemoryFactIdSchema });
type SavePayload = z.output<typeof SavePayload>;

const SaveInverse = z.discriminatedUnion('undo', [
  z.strictObject({
    undo: z.literal('forget'),
    factId: MemoryFactIdSchema,
    savedAt: z.iso.datetime(),
  }),
  z.strictObject({
    undo: z.literal('restore'),
    factId: MemoryFactIdSchema,
    savedAt: z.iso.datetime(),
  }),
]);

/** Stores the value as a proposed fact, from this chat turn: the payload is its id. */
async function stashFact(
  scope: ToolScope,
  input: { subject: MemorySubject; key: string; value: string; sensitive: boolean | null },
  turnId: string | null,
): Promise<TrustJson> {
  const { fact } = await saveFactIn(
    scope.tx,
    scope.actor,
    {
      subject: input.subject,
      key: input.key,
      value: input.value,
      ...(input.sensitive !== null && { sensitive: input.sensitive }),
    },
    {
      source: 'chat',
      turnId: turnId === null ? null : ConversationTurnIdSchema.parse(turnId),
      status: 'proposed',
    },
    { clock: scope.deps.clock },
  );
  return { factId: fact.id };
}

/** Makes the proposed fact the subject's current one, as the dial or the member allowed. */
async function performSave(scope: ToolScope, payload: SavePayload): Promise<Performed> {
  const { fact, change, before } = await activateFactIn(scope.tx, scope.actor, payload.factId, {
    clock: scope.deps.clock,
  });
  const about = await subjectLabel(scope, fact.subject);
  const what = `${about}'s ${words(fact.key)}`;
  return {
    entity: { type: 'memory_fact', id: fact.id },
    targetKey: `memory:${subjectKey(fact.subject)}:${fact.key}`,
    // The member who asked: the domain already limited the subject to what they reach.
    recordOwner: scope.requester,
    appointmentStartsAt: null,
    before: change === 'updated' && before !== null ? factSide(before, about) : null,
    after: { ...factSide(fact, about), change },
    // What the member decided on: the save, and the fact it replaces as it was then.
    touched: {
      proposed: payload.factId,
      current: before === null ? null : { id: before.id, updatedAt: before.updatedAt },
    },
    inverse:
      change === 'created'
        ? { undo: 'forget', factId: fact.id, savedAt: fact.updatedAt }
        : change === 'updated'
          ? { undo: 'restore', factId: fact.id, savedAt: fact.updatedAt }
          : null,
    summary:
      change === 'created'
        ? `Remember ${what}.`
        : change === 'updated'
          ? `Update ${what} (the old one can be brought back with Undo).`
          : `${what[0]?.toUpperCase() ?? ''}${what.slice(1)} is already remembered like this.`,
    facts: [{ kind: 'memory_fact', ref: fact.id, value: null }],
  };
}

async function undoSave(scope: ToolScope, inverse: TrustJson): Promise<void> {
  const parsed = SaveInverse.parse(inverse);
  const savedAt = new Date(parsed.savedAt);
  if (parsed.undo === 'forget') {
    await forgetSavedFactIn(scope.tx, scope.actor, parsed.factId, savedAt);
  } else {
    await restoreFactIn(scope.tx, scope.actor, parsed.factId, savedAt, {
      clock: scope.deps.clock,
    });
  }
}

async function unstashFact(scope: ToolScope, payload: TrustJson): Promise<void> {
  const parsed = SavePayload.safeParse(payload);
  if (parsed.success) await discardProposedFactIn(scope.tx, scope.actor, parsed.data.factId);
}

const RememberArgs = z.strictObject({
  about: z
    .enum(['client', 'staff', 'service', 'business'])
    .describe('Whom or what it is about; business: the whole business'),
  id: IdArg('client, staff member or service')
    .nullable()
    .describe('Its id from a lookup tool; null for the business'),
  key: KeyArg,
  value: ValueArg,
  sensitive: z
    .boolean()
    .nullable()
    .describe('true for health or personal matters; null: decided by the key'),
});
type RememberArgs = z.output<typeof RememberArgs>;

function subjectOf(args: RememberArgs): MemorySubject {
  if (args.about === 'business') {
    if (args.id !== null) {
      throw new InvalidToolArgumentsError('A fact about the business has no id (id: null).');
    }
    return { type: 'business' };
  }
  if (args.id === null) {
    throw new InvalidToolArgumentsError(`Give the ${args.about}'s id from a lookup tool.`);
  }
  switch (args.about) {
    case 'client':
      return { type: 'client', id: ClientIdSchema.parse(args.id) };
    case 'staff':
      return { type: 'staff', id: StaffMemberIdSchema.parse(args.id) };
    case 'service':
      return { type: 'service', id: ServiceIdSchema.parse(args.id) };
  }
}

export const rememberFact: WriteTool = {
  kind: 'write',
  name: 'remember_fact',
  // 2 (S36): closed days that stop bookings are propose_rule (lr-blackout).
  version: 2,
  localTimes: false,
  tier: 'internal_write',
  guide: {
    use: 'Remember what the member tells you plainly about a client, staff member, service or the business (an allergy, a preference, "the usual", a rule of thumb); a new value for a key replaces the old one. "Note that…" and "remember…" are this tool.',
    avoid: [
      'for a closure that stops bookings ("we\'re closed Dec 24–26" is propose_rule)',
      'for a staff member being off, away or busy at a time, said without "note" or "remember" ("Marco is off on Friday" is block_time)',
      'for a guess, a question, or something you worked out yourself (only what the member said)',
      'for text from outside the team (a client message): ask the member first',
      'for contact details (they belong on the client record)',
      'for what happened at one appointment (use add_visit_note)',
    ],
    returns:
      'the saved fact, done (the member can undo it) or waiting for the member’s OK. Never repeat a value back as saved unless it is done.',
    examples: [
      {
        say: 'Remember that Maria is allergic to PPD',
        args: { about: 'client', id: { $any: true }, key: 'allergy', value: { $regex: 'ppd' } },
      },
      {
        say: 'Note that we close at 4 on Christmas Eve',
        args: { about: 'business', id: null, value: { $regex: '4' } },
      },
    ],
  },
  args: RememberArgs,
  payload: SavePayload,
  actions: () => ['client_note.save'],
  async stash(scope, args: RememberArgs, origin) {
    return stashFact(
      scope,
      { subject: subjectOf(args), key: args.key, value: args.value, sensitive: args.sensitive },
      origin.turnId,
    );
  },
  unstash: unstashFact,
  perform: (scope, payload: SavePayload) => performSave(scope, payload),
  undo: undoSave,
};

const VisitNoteArgs = z.strictObject({
  bookingId: IdArg('booking').describe(
    "The visit's booking id, from find_client_bookings or get_day",
  ),
  key: KeyArg,
  value: ValueArg,
});
type VisitNoteArgs = z.output<typeof VisitNoteArgs>;

export const addVisitNote: WriteTool = {
  kind: 'write',
  name: 'add_visit_note',
  version: 1,
  localTimes: false,
  tier: 'internal_write',
  guide: {
    use: 'Note what was done at one appointment, as the member tells you (a color formula, the massage pressure, the products used), so "same as last time" works next time.',
    avoid: [
      'for something true of the client in general (use remember_fact)',
      'for a guess or anything the member did not say',
    ],
    returns: 'the saved note, done (the member can undo it) or waiting for the member’s OK.',
    examples: [
      {
        say: "Note on Maria's appointment today: 6N with 20 vol, 35 minutes",
        evalSay: "Note on Maria's next appointment: 6N with 20 vol, 35 minutes",
        args: { bookingId: { $any: true }, value: { $regex: '6n' } },
      },
      {
        say: "For Ana's last visit: firm pressure, focus on shoulders",
        args: { bookingId: { $any: true }, value: { $regex: 'firm' } },
        evalSkip: 'the eval world has no past visit for Ana (memory_write covers notes on one)',
      },
    ],
  },
  args: VisitNoteArgs,
  payload: SavePayload,
  actions: () => ['client_note.save'],
  async stash(scope, args: VisitNoteArgs, origin) {
    return stashFact(
      scope,
      {
        subject: { type: 'booking', id: BookingIdSchema.parse(args.bookingId) },
        key: args.key,
        value: args.value,
        sensitive: null,
      },
      origin.turnId,
    );
  },
  unstash: unstashFact,
  perform: (scope, payload: SavePayload) => performSave(scope, payload),
  undo: undoSave,
};

const ForgetArgs = z.strictObject({
  factId: IdArg('remembered fact').describe(
    "The fact's id, from the memory that came with a record",
  ),
});
type ForgetArgs = z.output<typeof ForgetArgs>;

export const forgetFact: WriteTool = {
  kind: 'write',
  name: 'forget_fact',
  version: 1,
  localTimes: false,
  // Final: the value goes from memory, chats and summaries, with no Undo.
  tier: 'external_or_irreversible',
  alwaysAsks: true,
  guide: {
    use: 'Forget one remembered fact or visit note when the member asks (it is removed everywhere, for good). Look the record up first: `factId` is the factId of a fact in its memory, never the client’s or booking’s id. To forget several ("everything about Maria"), call it once per fact.',
    avoid: [
      'to change a value (use remember_fact with the same key)',
      'unless the member asked to forget it',
    ],
    returns: 'the forget, always waiting for the member’s OK on the card.',
    examples: [
      {
        say: 'Forget what I told you about Maria’s allergy',
        args: { factId: { $any: true } },
        evalSkip: 'the eval world remembers nothing about Maria (memory_delete covers it)',
      },
      {
        say: 'Delete that note about parking',
        args: { factId: { $any: true } },
        evalSkip: 'refers to a fact named earlier in the conversation',
      },
    ],
  },
  args: ForgetArgs,
  actions: () => ['client_note.save'],
  async perform(scope, args: ForgetArgs): Promise<Performed> {
    const id = MemoryFactIdSchema.parse(args.factId);
    const fact = await getFactIn(scope.tx, scope.actor, id);
    const about = await subjectLabel(scope, fact.subject);
    await forgetFactIn(scope.tx, scope.actor, id);
    return {
      entity: { type: 'memory_fact', id },
      targetKey: `memory_fact:${id}`,
      recordOwner: scope.requester,
      appointmentStartsAt: null,
      before: factSide(fact, about),
      after: { factId: id, about, key: fact.key, forgotten: true },
      touched: { factId: id, updatedAt: fact.updatedAt },
      inverse: null,
      summary: `Forget ${about}'s ${words(fact.key)} everywhere, for good.`,
      facts: [{ kind: 'memory_fact', ref: id, value: null }],
    };
  },
  undo() {
    return Promise.reject(new Error('Forgetting cannot be undone'));
  },
};
