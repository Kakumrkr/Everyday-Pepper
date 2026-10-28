'use client';

import {
  MEMORY_FACTS_PAGE,
  type MemoryEpisode,
  type MemoryFactView,
  type Permission,
} from '@pepper/contracts';
import { Badge, Button, chipStyle, EmptyState, Switch } from '@pepper/ui';
import { useState } from 'react';
import { ROUTES } from '../../../lib/account';
import { sendJson } from '../../../lib/client-api';
import {
  canChange,
  groupFacts,
  MEMORY_FILTERS,
  matchesFilter,
  type MemoryFilter,
} from '../../../lib/memory';
import { kitLink } from '../kit-link';
import { FactItem } from './fact-item';

/**
 * "What I know" (S32, playbook §7): everything Pepper remembers that the member may read,
 * grouped and filtered, each with where it came from; the member's own past conversations;
 * and the pause switch. Nothing here is cached (`no-store` answers, ADR-0038). On the kit since
 * S42.3: each group a quiet block of hairline rows, and an empty memory that offers the chat,
 * where Pepper learns (AC-X-7).
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
        <p className="m-0 rounded-md bg-warn-soft px-4 py-3 type-label text-warn">
          I remember more than {MEMORY_FACTS_PAGE} things; these are the first {MEMORY_FACTS_PAGE}.
          A client’s profile shows everything about them.
        </p>
      ) : null}
      {facts.length === 0 ? null : (
        <div role="group" aria-label="Show" className="flex flex-wrap gap-2">
          {MEMORY_FILTERS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              onClick={() => {
                setFilter(key);
              }}
              className={chipStyle(filter === key)}
            >
              {label} · {facts.filter((fact) => matchesFilter(fact, key)).length}
            </button>
          ))}
        </div>
      )}
      {facts.length === 0 ? (
        <EmptyState
          icon="memory"
          title="I don’t remember anything yet."
          body="Tell me in chat, like “Remember that Maria is allergic to PPD”, and it shows up here."
          action={{ label: 'Tell Pepper in chat', href: ROUTES.chat, renderLink: kitLink }}
        />
      ) : groups.length === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-lg bg-surface-2 px-4 py-4">
          <p className="m-0 type-body text-ink-2">Nothing here for this filter.</p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setFilter('all');
            }}
          >
            Show everything
          </Button>
        </div>
      ) : (
        groups.map((group) => (
          <section
            key={group.key}
            aria-labelledby={`memory-${group.key}`}
            className="flex flex-col gap-3"
          >
            <h2 id={`memory-${group.key}`} className="m-0 type-heading">
              {group.title}
            </h2>
            <ul className="m-0 list-none divide-y divide-line rounded-lg bg-surface p-0 px-4">
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
              <p className="m-0 type-caption text-ink-2">
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

  const said = paused
    ? 'I’m not saving anything new from chat. What I already know still helps, and you can still fix or delete it.'
    : 'I remember what you tell me in chat. Pause it any time; what I already know stays until you delete it.';
  return (
    <section aria-label="Learn new things" className="rounded-lg bg-surface px-4 py-1">
      {canPause ? (
        <Switch
          label="Learn new things"
          hint={said}
          checked={!paused}
          disabled={busy}
          onChange={() => {
            void toggle();
          }}
        />
      ) : (
        <div className="flex flex-col gap-0.5 py-2">
          <p className="m-0 flex items-center justify-between gap-4 type-body text-ink">
            Learn new things
            <Badge tone={paused ? 'warn' : 'ok'}>{paused ? 'Paused' : 'On'}</Badge>
          </p>
          <p className="m-0 type-caption text-ink-2">{said} Owners and managers can change this.</p>
        </div>
      )}
      {error === null ? null : (
        <p role="alert" className="m-0 pb-2 type-label text-danger">
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
      <div className="flex flex-col gap-1">
        <h2 id="memory-episodes" className="m-0 type-heading">
          Our past conversations
        </h2>
        <p className="m-0 type-body text-ink-2">Only you see these.</p>
      </div>
      <ul className="m-0 list-none divide-y divide-line rounded-lg bg-surface p-0 px-4">
        {episodes.map((episode) => (
          <li key={episode.id} className="flex flex-col gap-1.5 py-3">
            <p className="m-0 type-body whitespace-pre-wrap text-ink">{episode.summary}</p>
            <p className="m-0 type-caption text-ink-2">
              {date.format(new Date(episode.createdAt))}
            </p>
            {confirming === episode.id ? (
              <div
                role="group"
                aria-label="Delete this conversation?"
                className="flex flex-wrap items-center gap-2"
              >
                <span className="type-body text-ink">Delete it? It can’t be undone.</span>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => {
                    void remove(episode.id);
                  }}
                >
                  Delete
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setConfirming(null);
                  }}
                >
                  Keep it
                </Button>
              </div>
            ) : (
              <Button
                variant="quiet"
                size="sm"
                className="self-start"
                aria-label={`Delete the conversation of ${date.format(new Date(episode.createdAt))}`}
                onClick={() => {
                  setConfirming(episode.id);
                }}
              >
                Delete
              </Button>
            )}
          </li>
        ))}
      </ul>
      {error === null ? null : (
        <p role="alert" className="m-0 type-label text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
