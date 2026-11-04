import type { ReactNode } from 'react';

/**
 * A signed-in screen's one action (S51, S51.2): on a phone fixed above the tabs within thumb
 * reach (DESIGN D3), on a desktop at the end of the page. The screen keeps room for it below.
 */
export function TabActionBar({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div
      className="fixed inset-x-0 bottom-[calc(var(--spacing-tab-bar)+env(safe-area-inset-bottom))] z-10 border-t border-line bg-bg px-5 py-3 desk:static desk:border-0 desk:px-0 desk:py-0"
      data-testid={testId}
    >
      <div className="mx-auto flex max-w-xl justify-end desk:justify-start">{children}</div>
    </div>
  );
}
