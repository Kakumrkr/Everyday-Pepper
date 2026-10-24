import {
  addToWaitlistIn,
  changeWaitlistEntryIn,
  makeWaitlistOffersIn,
  offerEmailDetails,
  offerUrl,
  SlotUnavailableError,
  takeBackWaitlistOffersIn,
  waitlistOfferEmail,
} from '@pepper/appointments';
import {
  ClientIdSchema,
  MAX_WAITLIST_WINDOWS,
  ServiceIdSchema,
  StaffMemberIdSchema,
  UtcDateTimeSchema,
  WAITLIST_OFFER_LIMITS,
  WaitlistEntryIdSchema,
  WaitlistMatchIdSchema,
  WaitlistOfferIdSchema,
} from '@pepper/contracts';
import { findCurrentTenant } from '@pepper/db';
import type { TrustJson, WaitlistEntry } from '@pepper/contracts';
import { z } from 'zod';
import { localOf } from '../local-time.js';
import { shortClientName } from '../names.js';
import type { Performed, ToolScope, WriteScope, WriteTool } from '../tool.js';
import {
  clientNames,
  DateArg,
  day,
  directoryOf,
  domainOptions,
  IdArg,
  serviceName,
  staffLogin,
  staffName,
  when,
} from './shared.js';

// The smart waitlist in the chat and the worker (S37, ADR-0041). `add_to_waitlist` puts a
// client on the list for times that are full (internal write, dial action `waitlist.change`,
// "do it and tell me" by default, Undo takes the entry off). `send_waitlist_offers` is the
// worker's.
//
// The smart waitlist's offer (S37, ADR-0041, AC-W5-1): a freed time offered to the ranking's
// best few at once, each by email with their own claim link; whoever claims first books it.
// The worker's matcher calls it through the trust layer, so the dial for
// `message.waitlist_offer` decides: ask (the default) puts it under "Needs your OK", notify or
// auto sends it. It is never offered to the model. Everything is the domain's: who (the
// ranking, checked again on every run), the time (still free), the links and the words. Undo,
// until the emails leave, takes the offers back.

const OfferArgs = z.strictObject({
  matchId: z.uuid(),
  staffMemberId: z.uuid(),
  /** The freed time (UTC). */
  startsAt: UtcDateTimeSchema,
  /** The ranking's best, with their rank and what *Why?* says about them. */
  entries: z
    .array(
      z.strictObject({
        entryId: z.uuid(),
        rank: z.number().int().min(1).max(WAITLIST_OFFER_LIMITS.maxFanOut),
        fit: z.enum(['asked_for_staff', 'anyone']),
        waitingSince: UtcDateTimeSchema,
        visits: z.number().int().min(0),
      }),
    )
    .min(1)
    .max(WAITLIST_OFFER_LIMITS.maxFanOut),
});
export type WaitlistOfferArgs = z.infer<typeof OfferArgs>;

const Inverse = z.strictObject({
  offerIds: z.array(z.uuid()).max(WAITLIST_OFFER_LIMITS.maxFanOut),
});

/** "Maria L., Sara K. and Ana R." */
function names(list: readonly string[]): string {
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list.at(-1) ?? ''}`;
}

export const sendWaitlistOffers: WriteTool = {
  kind: 'write',
  name: 'send_waitlist_offers',
  version: 1,
  localTimes: false,
  tier: 'external_or_irreversible',
  guide: {
    use: 'Offer a freed time to the best matches on the waitlist (the worker proposes it; never offered to the model).',
    avoid: ['for anything the member asks in the chat'],
    returns: 'the offers sent, or waiting for an OK.',
    // Never offered to the model, so never read: they only satisfy the guide's shape.
    examples: [
      {
        say: 'Matcher: Jess is free Tuesday at 10:00 and three clients are waiting',
        args: { matchId: { $any: true } },
      },
      {
        say: 'Matcher: Marco is free Friday at 14:00 and one client is waiting',
        args: { matchId: { $any: true } },
      },
    ],
  },
  args: OfferArgs,
  actions: () => ['message.waitlist_offer'],
  async perform(scope, raw): Promise<Performed> {
    const args = OfferArgs.parse(raw);
    const matchId = WaitlistMatchIdSchema.parse(args.matchId);
    const staffMemberId = StaffMemberIdSchema.parse(args.staffMemberId);
    const start = new Date(args.startsAt);
    const tenant = await findCurrentTenant(scope.tx);
    if (tenant === undefined) throw new Error('No business in this transaction');

    // Checked again on every run: still waiting, still free, still time to claim.
    const made = await makeWaitlistOffersIn(
      scope.tx,
      scope.actor,
      {
        matchId,
        staffMemberId,
        startsAt: start,
        entries: args.entries.map((e) => ({
          entryId: WaitlistEntryIdSchema.parse(e.entryId),
          rank: e.rank,
        })),
      },
      {
        now: scope.now,
        ...(scope.deps.templateRuleDefaults !== undefined && {
          templateRuleDefaults: scope.deps.templateRuleDefaults,
        }),
      },
    );
    if (made.length === 0) throw new SlotUnavailableError([]);

    const directory = await directoryOf(scope);
    const offeredTo: string[] = [];
    const services = new Set<string>();
    for (const { offer, token } of made) {
      const details = await offerEmailDetails(scope.tx, tenant, offer);
      // Candidates have an address; one removed meanwhile is simply not emailed.
      if (details === undefined) continue;
      offeredTo.push(shortClientName(details.clientName));
      services.add(serviceName(directory, offer.serviceId));
      await scope.emailClient({
        clientId: ClientIdSchema.parse(offer.clientId),
        template: 'waitlist_offer',
        dedupeKey: `waitlist.offer:${offer.id}`,
        message: waitlistOfferEmail(
          details,
          offerUrl(scope.deps.emails.baseUrl, tenant.slug, token),
          offer.expiresAt.toISOString(),
        ),
      });
    }

    const staff = staffName(directory, staffMemberId);
    const local = localOf(scope.timeZone, start);
    const service = [...services].join(' / ');
    const ranked = new Map(args.entries.map((e) => [e.entryId, e]));
    return {
      entity: { type: 'waitlist_match', id: matchId },
      targetKey: `waitlist_match:${matchId}`,
      // The business's to hand out: owners and managers decide.
      recordOwner: null,
      appointmentStartsAt: start,
      before: null,
      after: {
        date: local.date,
        time: local.time,
        staffName: staff,
        serviceName: service,
        offeredTo: names(offeredTo),
        offers: made.length,
      },
      touched: {
        slot: args.startsAt,
        entries: made.map(({ offer }) => offer.entryId),
      },
      inverse: { offerIds: made.map(({ offer }) => offer.id) },
      summary: `Offer ${staff}'s opening ${when(local.date, local.time)} to ${names(offeredTo)}; the first to claim it books it.`,
      facts: [
        {
          kind: 'slot_was_free',
          ref: null,
          value: { date: local.date, time: local.time, staffName: staff },
        },
        ...made.map(({ offer }, i) => {
          const why = ranked.get(offer.entryId);
          return {
            kind: 'waitlist_rank',
            ref: offer.entryId,
            value: {
              rank: offer.rank,
              clientName: offeredTo[i] ?? 'a client',
              fit: why?.fit ?? 'anyone',
              waitingSince: localOf(scope.timeZone, why?.waitingSince ?? args.startsAt).date,
              visits: why?.visits ?? 0,
            },
          };
        }),
      ],
      // Client names came from outside the team (the booking page).
      untrustedText: true,
    };
  },
  async undo(scope, raw): Promise<void> {
    // The trust layer takes the emails back; the offers close and the entries wait again.
    const { offerIds } = Inverse.parse(raw);
    await takeBackWaitlistOffersIn(
      scope.tx,
      offerIds.map((id) => WaitlistOfferIdSchema.parse(id)),
    );
  },
};

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM, e.g. 09:30');

const WaitArgs = z.strictObject({
  clientId: IdArg('client'),
  serviceId: IdArg('service'),
  staffMemberId: IdArg('staff member')
    .nullable()
    .describe('Only with this staff member, if the member said so; null: anyone who offers it'),
  windows: z
    .array(
      z.strictObject({
        date: DateArg,
        start: HHMM.describe("From, 24-hour HH:MM in the business's time zone"),
        end: z
          .string()
          .regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/, 'Use HH:MM, e.g. 17:00')
          .describe('Until, 24-hour HH:MM; 24:00 for the end of the day'),
      }),
    )
    .min(1)
    .max(MAX_WAITLIST_WINDOWS)
    .describe(
      'When the client could come: one window per day, e.g. Saturday mornings = each Saturday asked about, 09:00 to 12:00 (or opening to noon)',
    ),
});
type WaitArgs = z.output<typeof WaitArgs>;

/** "Sat 2026-11-07 09:00–12:00, Sat 2026-11-14 09:00–12:00". */
function windowsText(windows: WaitArgs['windows']): string {
  const shown = windows.slice(0, 3).map((w) => `${day(w.date)} ${w.start}–${w.end}`);
  const more = windows.length - shown.length;
  return `${shown.join(', ')}${more > 0 ? ` and ${String(more)} more` : ''}`;
}

export const addToWaitlist: WriteTool = {
  kind: 'write',
  name: 'add_to_waitlist',
  version: 1,
  localTimes: true,
  tier: 'internal_write',
  guide: {
    use: 'Put a client (id from find_clients) on the waitlist for a service at times that are full, so Pepper offers them a time that frees up. Windows are local dates with from and until times.',
    avoid: [
      'when a time they want is free (book it, or offer the free times from find_availability)',
      'to offer or send a time to someone waiting: Pepper does that by itself when a time frees up',
    ],
    returns:
      'the entry, done or waiting for the member’s OK. When a matching time frees up, Pepper offers it to the best matches first.',
    examples: [
      {
        say: 'Put Maria on the waitlist for a haircut with Marco on Saturday morning',
        evalFull: [{ staff: '{{staff:marco}}', date: '2026-11-07', start: '10:00', end: '13:00' }],
        args: {
          clientId: { $any: true },
          serviceId: { $any: true },
          staffMemberId: { $any: true },
          windows: { $any: true },
        },
      },
      {
        say: 'Sara wants a haircut on Friday afternoon if anything opens up',
        evalSay: 'Sara Kim wants a haircut on Friday afternoon if anything opens up',
        evalFull: [
          { staff: '{{staff:jess}}', date: '2026-11-06', start: '12:00', end: '17:00' },
          { staff: '{{staff:marco}}', date: '2026-11-06', start: '12:00', end: '17:00' },
        ],
        args: { clientId: { $any: true }, staffMemberId: null, windows: { $any: true } },
      },
    ],
  },
  args: WaitArgs,
  actions: () => ['waitlist.change'],
  async perform(scope: WriteScope, args: WaitArgs): Promise<Performed> {
    const directory = await directoryOf(scope);
    const clientId = ClientIdSchema.parse(args.clientId);
    const serviceId = ServiceIdSchema.parse(args.serviceId);
    const staffMemberId =
      args.staffMemberId === null ? null : StaffMemberIdSchema.parse(args.staffMemberId);
    const entry = await addToWaitlistIn(
      scope.tx,
      scope.actor,
      { clientId, serviceId, staffMemberId, windows: args.windows },
      domainOptions(scope),
    );
    const names = await clientNames(scope, [clientId]);
    const client = names.get(clientId) ?? 'the client';
    const staff = staffMemberId === null ? 'anyone' : staffName(directory, staffMemberId);
    const service = serviceName(directory, serviceId);
    const windows = windowsText(entry.windows);
    return {
      entity: { type: 'waitlist_entry', id: entry.id },
      targetKey: `waitlist:${clientId}:${serviceId}`,
      // A staff member's own entry is theirs to decide; "anyone" is the business's.
      recordOwner: staffMemberId === null ? null : staffLogin(directory, staffMemberId),
      appointmentStartsAt: null,
      before: null,
      after: { clientName: client, serviceName: service, staffName: staff, windows },
      touched: null,
      inverse: { entryId: entry.id },
      summary: `${client} is on the waitlist for a ${service.toLowerCase()} with ${staff}: ${windows}.`,
      facts: [],
    };
  },
  async undo(scope, inverse) {
    const { entryId } = z.strictObject({ entryId: WaitlistEntryIdSchema }).parse(inverse);
    await changeWaitlistEntryIn(
      scope.tx,
      scope.actor,
      entryId,
      { status: 'cancelled' },
      domainOptions(scope),
    );
  },
};

/** Waitlist entries a read shows (S37): open ones, longest waiting first. */
export const WAITLIST_SHOWN = 20;

/**
 * Open waitlist entries as the AI reads them: ids, the client's short name, the service, with
 * whom ("anyone") and the windows as local dates and times. `offered`: a freed time was offered
 * and the answer is pending. Never a contact.
 */
export async function waitlistViews(
  scope: ToolScope,
  entries: readonly WaitlistEntry[],
): Promise<TrustJson[]> {
  if (entries.length === 0) return [];
  const directory = await directoryOf(scope);
  const names = await clientNames(scope, [...new Set(entries.map((e) => e.clientId))]);
  return entries.map((entry) => ({
    entryId: entry.id,
    clientId: entry.clientId,
    client: names.get(entry.clientId) ?? 'a client',
    service: serviceName(directory, entry.serviceId),
    staffMemberId: entry.staffMemberId,
    staff: entry.staffMemberId === null ? 'anyone' : staffName(directory, entry.staffMemberId),
    windows: entry.windows.map((w) => ({ date: w.date, from: w.start, to: w.end })),
    offered: entry.status === 'offered',
  }));
}
