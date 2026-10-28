'use client';

import { useState } from 'react';

/**
 * A screen's add sheet that opens from its header button (its trigger) and from the empty
 * list's action (AC-X-7), when a save leaves the screen (Clients: the new profile). On close
 * focus goes back to the button that opened it; when that button is gone the Sheet hands focus
 * to its trigger. Screens that stay and refresh (Services, Team) return to the trigger always.
 */
export function useSheetOpener(): {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens the sheet from the focused button (the empty list's action). */
  openFromHere: () => void;
  returnFocus: (() => HTMLElement | null) | undefined;
} {
  const [open, setOpen] = useState(false);
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  return {
    open,
    onOpenChange: (next) => {
      // Opened by its own trigger: Radix returns focus there.
      if (next) setOpener(null);
      setOpen(next);
    },
    openFromHere: () => {
      const active = document.activeElement;
      // Safari doesn't focus a clicked button: then the trigger takes focus back.
      setOpener(active instanceof HTMLElement && active !== document.body ? active : null);
      setOpen(true);
    },
    returnFocus: opener === null ? undefined : () => (opener.isConnected ? opener : null),
  };
}
