'use client';

import { Button } from '@pepper/ui';
import { useState } from 'react';
import { fetchExport } from '../../lib/export';

type State =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'saved'; name: string }
  | { kind: 'failed'; message: string };

/** Saves `file` as `name` through a link the browser downloads (no page leaves). */
function save(file: Blob, name: string) {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  // Some browsers read the file after the click returns; let them before it's released.
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}

/**
 * "Download your data" (S51, ADR-0053, AC-W1-37): the screen's one action, on a phone fixed
 * above the tabs within thumb reach (D3), on a desktop at the end of the page. What happened
 * is said beside it, for screen readers too.
 */
export function ExportDownload() {
  const [state, setState] = useState<State>({ kind: 'idle' });

  async function download() {
    setState({ kind: 'busy' });
    const result = await fetchExport();
    if (!result.ok) {
      setState({ kind: 'failed', message: result.message });
      return;
    }
    save(result.data.file, result.data.name);
    setState({ kind: 'saved', name: result.data.name });
  }

  return (
    <>
      <p aria-live="polite" className="m-0 type-body empty:hidden" data-testid="export-status">
        {state.kind === 'saved' && (
          <span className="text-ink">
            Saved as <span className="font-semibold break-all">{state.name}</span>. Keep it
            somewhere private: it has your clients’ details.
          </span>
        )}
        {state.kind === 'failed' && <span className="text-danger">{state.message}</span>}
      </p>
      <div
        className="fixed inset-x-0 bottom-[calc(var(--spacing-tab-bar)+env(safe-area-inset-bottom))] z-10 border-t border-line bg-bg px-5 py-3 desk:static desk:border-0 desk:px-0 desk:py-0"
        data-testid="export-actions"
      >
        <div className="mx-auto flex max-w-xl justify-end desk:justify-start">
          <Button
            className="w-full desk:w-auto"
            busy={state.kind === 'busy'}
            onClick={() => {
              void download();
            }}
          >
            {state.kind === 'busy' ? 'Getting your data…' : 'Download your data'}
          </Button>
        </div>
      </div>
    </>
  );
}
