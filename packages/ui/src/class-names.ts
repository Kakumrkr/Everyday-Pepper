/** Joins the truthy class names with spaces. */
export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}

export type ButtonVariant = 'primary' | 'secondary' | 'quiet';
export type ButtonSize = 'md' | 'sm';

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-2 rounded-full font-bold no-underline transition-colors ' +
  'focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-brand ' +
  'disabled:cursor-progress disabled:opacity-60';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-on-brand hover:bg-brand-strong',
  secondary: 'border border-line bg-surface text-ink hover:bg-surface-2',
  quiet: 'bg-transparent text-brand hover:bg-brand-soft',
};

// Both sizes keep the 44 px tap target; `sm` is only tighter sideways.
const BUTTON_SIZES: Record<ButtonSize, string> = {
  md: 'min-h-11 px-5 text-base',
  sm: 'min-h-11 px-3.5 text-sm',
};

/** Classes for a button, or a link that looks like one. */
export function buttonClass(
  options: { variant?: ButtonVariant; size?: ButtonSize; className?: string | undefined } = {},
): string {
  const { variant = 'primary', size = 'md', className } = options;
  return cx(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className);
}

/** Classes for a chip (filter or choice); `selected` marks the chosen one. */
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
