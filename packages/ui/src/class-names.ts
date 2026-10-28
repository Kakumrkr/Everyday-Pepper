/** Joins the truthy class names with spaces. */
export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}

/**
 * Classes for a pill chip (chat suggestions, Remembered), from before the kit; S43.2 moves its
 * last two users onto the kit's `chipStyle` with the legacy stylesheet.
 */
export function chipClass(
  options: { selected?: boolean; className?: string | undefined } = {},
): string {
  return cx(
    'inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-semibold no-underline',
    'focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-brand',
    options.selected === true
      ? 'border-brand bg-brand-soft text-ink'
      : 'border-line bg-surface text-ink-2 hover:bg-surface-2',
    options.className,
  );
}
