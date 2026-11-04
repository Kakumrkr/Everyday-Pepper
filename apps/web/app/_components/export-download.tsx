'use client';

import { Button } from '@pepper/ui';
import { useState } from 'react';
import { fetchExport } from '../../lib/export';
import { TabActionBar } from './tab-action-bar';

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
 * "Download your data" (S51, ADR-0053, AC-W1-37). On "Your data" it is the screen's one action
 * (`bar`, above the tabs on a phone); on "Delete business" it comes first but isn't the main
 * action (`inline`, secondary: S51.2's top-up, AC-W1-40). What happened is said beside it, for
 * screen readers too.
 */
export function ExportDownload({ placement = 'bar' }: { placement?: 'bar' | 'inline' }) {
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

  const button = (
    <Button
      className={placement === 'bar' ? 'w-full desk:w-auto' : undefined}
      variant={placement === 'bar' ? 'primary' : 'secondary'}
      busy={state.kind === 'busy'}
      onClick={() => {
        void download();
      }}
    >
      {state.kind === 'busy' ? 'Getting your data…' : 'Download your data'}
    </Button>
  );
  const status = (
    <p aria-live="polite" className="m-0 type-body empty:hidden" data-testid="export-status">
      {state.kind === 'saved' && (
        <span className="text-ink">
          Saved as <span className="font-semibold break-all">{state.name}</span>. Keep it somewhere
          private: it has your clients’ details.
        </span>
      )}
      {state.kind === 'failed' && <span className="text-danger">{state.message}</span>}
    </p>
  );
  if (placement === 'inline') {
    return (
      <div className="flex flex-col items-start gap-3">
        {button}
        {status}
      </div>
    );
  }
  return (
    <>
      {status}
      <TabActionBar testId="export-actions">{button}</TabActionBar>
    </>
  );
}
