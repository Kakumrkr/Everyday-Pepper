'use client';

import { Checkbox } from '@pepper/ui';

/**
 * "Email the client" on a team change of a booking (ADR-0025): ticked by default; untick it
 * for a walk-in, or a booking made for someone without telling them. The api skips clients
 * without an email address either way.
 */
export function NotifyClient({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** What the email says, e.g. "Email the client a confirmation". */
  children: string;
}) {
  return (
    <Checkbox
      name="notifyClient"
      label={children}
      checked={checked}
      onChange={(event) => {
        onChange(event.target.checked);
      }}
    />
  );
}
