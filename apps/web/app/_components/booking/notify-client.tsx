'use client';

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
    <label className="flex min-h-11 items-center gap-3 font-semibold">
      <input
        name="notifyClient"
        type="checkbox"
        className="size-5 min-h-0 w-auto accent-brand"
        checked={checked}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      {children}
    </label>
  );
}
