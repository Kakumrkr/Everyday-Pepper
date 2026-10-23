'use client';

import { BookingIdSchema, MemoryFactsResponseSchema, type MemoryFactView } from '@pepper/contracts';
import { useCallback, useEffect, useState } from 'react';
import { fetchJson } from '../../../lib/client-api';
import { SUGGESTED_KEYS } from '../../../lib/memory';
import { AddFact } from './add-fact';
import { FactItem } from './fact-item';

/**
 * A visit's notes on its booking sheet (S32, playbook D-14): what was done ("6N + 20 vol"),
 * read fresh when the sheet opens, added, edited and deleted by hand. "Same as last time"
 * reads them.
 */
export function VisitNotes({
  bookingId,
  timeZone,
  canChange,
}: {
  bookingId: string;
  timeZone: string;
  canChange: boolean;
}) {
  const [notes, setNotes] = useState<MemoryFactView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const answer = await fetchJson(
      `/v1/memory/facts?${new URLSearchParams({ bookingId }).toString()}`,
      MemoryFactsResponseSchema,
    );
    if (answer.ok) {
      setNotes(answer.data.facts);
      setError(null);
    } else setError(answer.message);
  }, [bookingId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section aria-labelledby={`visit-notes-${bookingId}`} className="flex flex-col gap-2">
      <h3 id={`visit-notes-${bookingId}`} className="m-0 text-base font-bold">
        Visit notes
      </h3>
      {error !== null ? (
        <p role="alert" className="m-0 text-sm text-danger">
          {error}
        </p>
      ) : notes === null ? (
        <p className="m-0 text-sm text-ink-2">Reading the notes…</p>
      ) : notes.length === 0 ? (
        <p className="m-0 text-sm text-ink-2">No notes for this visit yet.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {notes.map((fact) => (
            <li key={fact.id}>
              <FactItem
                fact={fact}
                timeZone={timeZone}
                canChange={canChange}
                about={null}
                onChanged={(changed) => {
                  setNotes((all) =>
                    (all ?? []).map((each) => (each.id === changed.id ? changed : each)),
                  );
                }}
                onForgotten={(id) => {
                  setNotes((all) => (all ?? []).filter((each) => each.id !== id));
                }}
              />
            </li>
          ))}
        </ul>
      )}
      {canChange ? (
        <AddFact
          subject={{ type: 'booking', id: BookingIdSchema.parse(bookingId) }}
          suggestions={SUGGESTED_KEYS.visit}
          legend="Add a visit note"
          onAdded={() => {
            void load();
          }}
        />
      ) : null}
    </section>
  );
}
