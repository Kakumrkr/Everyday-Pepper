'use client';

import {
  MEMORY_FACTS_PAGE,
  type MemoryEpisode,
  type MemoryFactView,
  type Permission,
} from '@pepper/contracts';
import { buttonClass, chipClass } from '@pepper/ui';
import { useState } from 'react';
import { sendJson } from '../../../lib/client-api';
import {
  canChange,
  groupFacts,
  MEMORY_FILTERS,
  matchesFilter,
  type MemoryFilter,
} from '../../../lib/memory';
import { FactItem } from './fact-item';

/**
 * "What I know" (S32, playbook §7): everything Pepper remembers that the member may read,
 * grouped and filtered, each with where it came from; the member's own past conversations;
 * and the pause switch. Nothing here is cached (`no-store` answers, ADR-0038).
 */
export function MemoryScreen({
  initialFacts,
  initialEpisodes,
  paused: initialPaused,
  permissions,
  timeZone,
}: {
  initialFacts: MemoryFactView[];
  initialEpisodes: MemoryEpisode[];
  paused: boolean;
  permissions: readonly Permission[];
  timeZone: string;
}) {
  const [facts, setFacts] = useState(initialFacts);
  const [episodes, setEpisodes] = useState(initialEpisodes);
  const [filter, setFilter] = useState<MemoryFilter>('all');
  const [said, setSaid] = useState('');
  const groups = groupFacts(facts, filter);

  return (
    <div className="flex flex-col gap-6">
      <PauseSwitch paused={initialPaused} canPause={permissions.includes('settings.manage')} />
      {initialFacts.length >= MEMORY_FACTS_PAGE ? (
        <p className="m-0 rounded-md bg-wait-soft px-4 py-3 text-sm text-wait">
          I remember more than {MEMORY_FACTS_PAGE} things; these are the first {MEMORY_FACTS_PAGE}.
          A client’s profile shows everything about them.
        </p>
      ) : null}
      <div role="group" aria-label="Show" className="flex flex-wrap gap-2">
        {MEMORY_FILTERS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            aria-pressed={filter === key}
            onClick={() => {
              setFilter(key);
            }}
            className={chipClass({ selected: filter === key })}
          >
            {label} · {facts.filter((fact) => matchesFilter(fact, key)).length}
          </button>
        ))}
      </div>
      {groups.length === 0 ? (
        <p className="m-0 rounded-md bg-surface-2 px-4 py-3 text-ink-2">
          {facts.length === 0
            ? 'I don’t remember anything yet. Tell me in chat, like “Remember that Maria is allergic to PPD”.'
            : 'Nothing here for this filter.'}
        </p>
      ) : (
        groups.map((group) => (
          <section
            key={group.key}
            aria-labelledby={`memory-${group.key}`}
            className="flex flex-col gap-2"
          >
            <h2 id={`memory-${group.key}`} className="m-0 font-display text-lg font-bold">
              {group.title}
            </h2>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {group.facts.map((fact) => (
                <li key={fact.id}>
                  <FactItem
                    fact={fact}
                    timeZone={timeZone}
                    canChange={canChange(fact.subject, permissions)}
                    onChanged={(changed) => {
                      setFacts((all) =>
                        all.map((each) => (each.id === changed.id ? changed : each)),
                      );
                      setSaid('Saved.');
                    }}
                    onForgotten={(id) => {
                      setFacts((all) => all.filter((each) => each.id !== id));
                      setSaid('Deleted. I’ve forgotten it everywhere.');
                    }}
                  />
                </li>
              ))}
            </ul>
            {group.key === 'clients' ? (
              <p className="m-0 text-xs text-ink-2">
                Sensitive facts are shown only to owners, managers and the client’s own stylist.
              </p>
            ) : null}
          </section>
        ))
      )}
      <Episodes
        episodes={episodes}
        timeZone={timeZone}
        onDeleted={(id) => {
          setEpisodes((all) => all.filter((each) => each.id !== id));
          setSaid('Deleted. I’ve forgotten that conversation.');
        }}
      />
      <p role="status" className="sr-only">
        {said}
      </p>
    </div>
  );
}

/**
 * The business's switch for learning new things (playbook D-15, principle 13): while paused,
 * chat and AI actions save nothing new and no conversation is summarised; what Pepper already
 * knows still helps and can still be deleted. Owners and managers change it; everyone sees it.
 */
function PauseSwitch({ paused: initial, canPause }: { paused: boolean; canPause: boolean }) {
  const [paused, setPaused] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setBusy(true);
    setError(null);
    const answer = await sendJson('PUT', '/v1/memory/settings', { paused: !paused });
    setBusy(false);
    if (answer.ok) setPaused(!paused);
    else setError(answer.message);
  }

  return (
    <section
      aria-labelledby="memory-learning"
      className="flex flex-col gap-2 rounded-md border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="memory-learning" className="m-0 text-base font-bold">
          Learn new things
        </h2>
        {canPause ? (
          <button
            type="button"
            role="switch"
            aria-checked={!paused}
            aria-labelledby="memory-learning"
            disabled={busy}
            onClick={() => {
              void toggle();
            }}
            className={buttonClass({ variant: paused ? 'secondary' : 'primary', size: 'sm' })}
          >
            {paused ? 'Paused' : 'On'}
          </button>
        ) : (
          <span className="text-sm font-semibold">{paused ? 'Paused' : 'On'}</span>
        )}
      </div>
      <p className="m-0 text-sm text-ink-2">
        {paused
          ? 'I’m not saving anything new from chat. What I already know still helps, and you can still fix or delete it.'
          : 'I remember what you tell me in chat. Pause it any time; what I already know stays until you delete it.'}
        {canPause ? null : ' Owners and managers can change this.'}
      </p>
      {error === null ? null : (
        <p role="alert" className="m-0 text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}

/** The member's own past conversations as Pepper summarised them (S31): theirs only. */
function Episodes({
  episodes,
  timeZone,
  onDeleted,
}: {
  episodes: MemoryEpisode[];
  timeZone: string;
  onDeleted: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (episodes.length === 0) return null;
  const date = new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' });

  async function remove(id: string) {
    setError(null);
    const answer = await sendJson('DELETE', `/v1/memory/episodes/${id}`, undefined);
    setConfirming(null);
    if (answer.ok || answer.status === 404) onDeleted(id);
    else setError(answer.message);
  }

  return (
    <section aria-labelledby="memory-episodes" className="flex flex-col gap-2">
      <h2 id="memory-episodes" className="m-0 font-display text-lg font-bold">
        Our past conversations
      </h2>
      <p className="m-0 text-sm text-ink-2">Only you see these.</p>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {episodes.map((episode) => (
          <li
            key={episode.id}
            className="flex flex-col gap-1.5 rounded-md border border-line bg-surface p-3"
          >
            <p className="m-0 whitespace-pre-wrap">{episode.summary}</p>
            <p className="m-0 text-xs text-ink-2">{date.format(new Date(episode.createdAt))}</p>
            {confirming === episode.id ? (
              <div
                role="group"
                aria-label="Delete this conversation?"
                className="flex flex-wrap items-center gap-2"
              >
                <span className="text-sm">Delete it? It can’t be undone.</span>
                <button
                  type="button"
                  onClick={() => {
                    void remove(episode.id);
                  }}
                  className={buttonClass({ size: 'sm', className: 'bg-danger hover:bg-danger' })}
                >
                  Delete
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConfirming(null);
                  }}
                  className={buttonClass({ variant: 'secondary', size: 'sm' })}
                >
                  Keep it
                </button>
              </div>
            ) : (
              <button
                type="button"
                aria-label={`Delete the conversation of ${date.format(new Date(episode.createdAt))}`}
                onClick={() => {
                  setConfirming(episode.id);
                }}
                className={buttonClass({ variant: 'quiet', size: 'sm', className: 'self-start' })}
              >
                Delete
              </button>
            )}
          </li>
        ))}
      </ul>
      {error === null ? null : (
        <p role="alert" className="m-0 text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
