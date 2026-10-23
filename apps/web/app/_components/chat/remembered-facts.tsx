'use client';

import { MemoryFactsShownResponseSchema, type MemoryFactShown } from '@pepper/contracts';
import { Remembered } from '@pepper/ui';
import { useState } from 'react';
import { sendJson } from '../../../lib/client-api';

/**
 * The "Remembered" chip under an answer (S32, playbook D-16): reads the facts it used live
 * when opened (`POST /v1/memory/facts/shown`, never cached), and fixes or forgets one in
 * place. A forgotten fact is gone from every later answer, in this chat too (AC-W7-2).
 */
export function RememberedFacts({ factIds }: { factIds: readonly string[] }) {
  const [open, setOpen] = useState(false);
  const [facts, setFacts] = useState<MemoryFactShown[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    const answer = await sendJson('POST', '/v1/memory/facts/shown', { factIds });
    if (!answer.ok) {
      setError(answer.message);
      return;
    }
    const parsed = MemoryFactsShownResponseSchema.safeParse(answer.data);
    if (parsed.success) setFacts(parsed.data.facts);
    else setError('Something went wrong. Try again.');
  }

  return (
    <Remembered
      count={factIds.length}
      facts={facts}
      error={error}
      open={open}
      onToggle={() => {
        // Read again each time it opens: a fact may have been changed or forgotten since.
        if (!open) void load();
        setOpen(!open);
      }}
      onFix={async (factId, value) => {
        const answer = await sendJson('PATCH', `/v1/memory/facts/${factId}`, { value });
        return answer.ok ? null : answer.message;
      }}
      onForget={async (factId) => {
        const answer = await sendJson('DELETE', `/v1/memory/facts/${factId}`, undefined);
        return answer.ok ? null : answer.message;
      }}
    />
  );
}
