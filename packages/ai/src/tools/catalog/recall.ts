import {
  type ActionExplanation,
  type ClientId,
  type MemoryFact,
  type MemoryFactId,
  type MemorySubject,
  type TrustJson,
} from '@pepper/contracts';
import { recallIn, subjectKey, type Recall } from '@pepper/core';
import { localOf } from '../local-time.js';
import type { ToolScope } from '../tool.js';
import { serviceName, staffName, type Directory } from './shared.js';

// What a business remembers, in the tools' answers (S30, playbook principles 2 and 7): facts
// travel with the record they are about, deterministically, never by similarity. An answer
// names each fact by reference (`{ "$fact": id }`); the agent fills the references in from the
// memory tables whenever it sends the answer (so a forgotten fact is gone from every later
// request, and a changed one is current) and labels them as untrusted data.

/** The most facts one record brings into an answer. */
export const FACTS_PER_RECORD = 8;

/** A fact named in a tool answer, filled in when the answer is sent. */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- a type, not an interface: it is JSON (`TrustJson`) as it stands
export type FactRef = { $fact: string };

export function factRef(id: MemoryFactId | string): FactRef {
  return { $fact: id };
}

/** The facts of these records and the last visits of these clients the member may read. */
export async function recallFor(
  scope: ToolScope,
  request: { subjects: readonly MemorySubject[]; lastVisitsOf?: readonly ClientId[] },
): Promise<Recall> {
  return recallIn(
    scope.tx,
    scope.actor,
    { subjects: request.subjects, lastVisitsOf: request.lastVisitsOf ?? [] },
    scope.now,
  );
}

/** One record's facts as references, sensitive first; `undefined` when it has none. */
export function refsOf(recall: Recall, subject: MemorySubject): FactRef[] | undefined {
  const facts = recall.facts.get(subjectKey(subject)) ?? [];
  return facts.length === 0
    ? undefined
    : facts.slice(0, FACTS_PER_RECORD).map((fact) => factRef(fact.id));
}

/** A client's last visit that has notes, for "same as last time" (`undefined`: none). */
export function lastVisitOf(
  scope: ToolScope,
  directory: Directory,
  recall: Recall,
  clientId: ClientId,
): TrustJson | undefined {
  const visit = recall.lastVisits.get(clientId);
  if (visit === undefined) return undefined;
  const start = localOf(scope.timeZone, visit.startsAt.toISOString());
  return {
    bookingId: visit.bookingId,
    date: start.date,
    time: start.time,
    serviceId: visit.serviceId,
    serviceName: serviceName(directory, visit.serviceId),
    staffMemberId: visit.staffMemberId,
    staffName: staffName(directory, visit.staffMemberId),
    notes: visit.notes.slice(0, FACTS_PER_RECORD).map((note) => factRef(note.id)),
  };
}

/**
 * What a booking for `clientId` and `serviceId` brings from memory (AC-W3-2): the client's facts
 * the template warns about for the service's category (an allergy on a color service), and the
 * notes of the client's last visit. For *Why?* and the card by id (`facts`), and for the model by
 * reference (`memory`, absent when there is nothing). Only what the member may read: a member
 * who may not read the client's sensitive facts gets no warning (S30 D-3).
 */
export async function bookingMemory(
  scope: ToolScope,
  directory: Directory,
  booking: { clientId: ClientId; serviceId: string },
): Promise<{ facts: ActionExplanation['facts']; memory: TrustJson | undefined }> {
  const category = directory.services.get(booking.serviceId)?.category?.toLowerCase() ?? null;
  const keys = new Set(
    (scope.deps.memoryWarnings ?? [])
      .filter((rule) => rule.serviceCategories.some((each) => each.toLowerCase() === category))
      .flatMap((rule) => rule.keys),
  );
  const client: MemorySubject = { type: 'client', id: booking.clientId };
  const recall = await recallFor(scope, { subjects: [client], lastVisitsOf: [booking.clientId] });
  const warnings: MemoryFact[] = (recall.facts.get(subjectKey(client)) ?? []).filter((fact) =>
    keys.has(fact.key),
  );
  const visit = recall.lastVisits.get(booking.clientId);
  const lastVisit = lastVisitOf(scope, directory, recall, booking.clientId);
  const facts: ActionExplanation['facts'] = [
    ...warnings.map((fact) => ({ kind: 'memory_warning', ref: fact.id, value: null })),
    ...(visit === undefined
      ? []
      : [
          {
            kind: 'last_visit',
            ref: visit.bookingId,
            value: {
              date: localOf(scope.timeZone, visit.startsAt.toISOString()).date,
              serviceName: serviceName(directory, visit.serviceId),
            },
          },
          ...visit.notes
            .slice(0, FACTS_PER_RECORD)
            .map((note) => ({ kind: 'memory_last_visit', ref: note.id, value: null })),
        ]),
  ];
  const memory =
    warnings.length === 0 && lastVisit === undefined
      ? undefined
      : {
          ...(warnings.length > 0 && {
            warnings: warnings.map((fact) => factRef(fact.id)),
            warningNote:
              'Tell the member about these before the appointment (they are on the card too).',
          }),
          ...(lastVisit !== undefined && { lastVisit }),
        };
  return { facts, memory };
}
