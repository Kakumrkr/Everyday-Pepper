'use client';

import { MemoryFactsResponseSchema, type ClientId, type MemoryFactView } from '@pepper/contracts';
import { Card } from '@pepper/ui';
import { useState } from 'react';
import { fetchJson } from '../../../lib/client-api';
import { SUGGESTED_KEYS, visitLine } from '../../../lib/memory';
import { AddFact } from './add-fact';
import { FactItem } from './fact-item';

/**
 * "What Pepper knows" about a client and the notes of their visits, on their profile (S32,
 * AC-W3-1): read, add, edit and delete by hand. Staff reach only their own clients' (the api
 * decides); a visit note is added from the visit on the calendar.
 */
export function ClientMemory({
  clientId,
  clientName,
  initialFacts,
  timeZone,
  canChange,
}: {
  clientId: ClientId;
  clientName: string;
  initialFacts: MemoryFactView[];
  timeZone: string;
  canChange: boolean;
}) {
  const [facts, setFacts] = useState(initialFacts);
  const [error, setError] = useState<string | null>(null);
  const about = facts.filter((fact) => fact.subject.type === 'client');
  const notes = facts.filter((fact) => fact.subject.type === 'booking');

  async function reload() {
    const answer = await fetchJson(
      `/v1/memory/facts?${new URLSearchParams({ clientId }).toString()}`,
      MemoryFactsResponseSchema,
    );
    if (answer.ok) setFacts(answer.data.facts);
    else setError(answer.message);
  }
  const item = (fact: MemoryFactView, about: string | null) => (
    <li key={fact.id}>
      <FactItem
        fact={fact}
        timeZone={timeZone}
        canChange={canChange}
        about={about}
        onChanged={(changed) => {
          setFacts((all) => all.map((each) => (each.id === changed.id ? changed : each)));
        }}
        onForgotten={(id) => {
          setFacts((all) => all.filter((each) => each.id !== id));
        }}
      />
    </li>
  );

  return (
    <>
      <Card>
        <section aria-labelledby="client-memory" className="flex flex-col gap-3">
          <h2 id="client-memory" className="m-0 font-display text-lg font-bold">
            What Pepper knows
          </h2>
          {about.length === 0 ? (
            <p className="m-0 text-ink-2">
              Nothing yet. Tell me in chat, like “Remember that {clientName} prefers mornings”.
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="client-facts">
              {about.map((fact) => item(fact, null))}
            </ul>
          )}
          {canChange ? (
            <AddFact
              subject={{ type: 'client', id: clientId }}
              suggestions={SUGGESTED_KEYS.client}
              legend={`Add something about ${clientName}`}
              onAdded={() => {
                void reload();
              }}
            />
          ) : null}
          {error === null ? null : (
            <p role="alert" className="m-0 text-sm text-danger">
              {error}
            </p>
          )}
        </section>
      </Card>
      <Card>
        <section aria-labelledby="client-visit-notes" className="flex flex-col gap-3">
          <h2 id="client-visit-notes" className="m-0 font-display text-lg font-bold">
            Visit notes
          </h2>
          {notes.length === 0 ? (
            <p className="m-0 text-ink-2">
              No notes yet. Add one from a visit on the calendar, like the color formula.
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="visit-notes">
              {notes.map((fact) => item(fact, visitLine(fact, timeZone)))}
            </ul>
          )}
        </section>
      </Card>
    </>
  );
}
