import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from '../class-names.js';
import { Icon, type IconName } from '../icons.js';

// Buttons of the kit (DESIGN.md §4): pills; one primary action per screen or sheet (D4).

export type KitButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';
export type KitButtonSize = 'sm' | 'md' | 'lg';

export const FOCUS_RING =
  'focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-brand';

// Every property the legacy element styles in globals.css also set is set here (S43 deletes them).
const BASE =
  'inline-flex items-center justify-center gap-2 rounded-pill py-2 font-semibold no-underline ' +
  'transition motion-fast ease-standard active:scale-98 ' +
  'disabled:cursor-not-allowed disabled:opacity-50 aria-busy:cursor-progress ' +
  FOCUS_RING;

const VARIANTS: Record<KitButtonVariant, string> = {
  primary: 'bg-brand text-brand-ink hover:opacity-90',
  secondary: 'border border-line-strong bg-surface text-ink hover:bg-surface-2',
  quiet: 'bg-transparent text-brand hover:bg-brand-soft',
  danger: 'border border-danger bg-surface text-danger hover:bg-danger-soft',
};

// Every size keeps the 44 px tap target (D3); primary actions are 48–54 px tall.
const SIZES: Record<KitButtonSize, string> = {
  sm: 'min-h-11 px-4 type-label',
  md: 'min-h-12 px-5 type-body font-semibold',
  lg: 'min-h-13.5 px-6 type-subheading',
};

/** The classes of a kit button, for a link that looks like one. */
export function buttonStyle(
  options: {
    variant?: KitButtonVariant | undefined;
    size?: KitButtonSize | undefined;
    block?: boolean | undefined;
  } = {},
): string {
  const { variant = 'primary', size = 'md', block = false } = options;
  return cx(BASE, VARIANTS[variant], SIZES[size], block && 'w-full');
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: KitButtonVariant;
  size?: KitButtonSize;
  /** Full width (the sticky action bar, sheets on phones). */
  block?: boolean;
  /** Working on it: the button says so and can't be pressed twice. */
  busy?: boolean;
  icon?: IconName;
  children: ReactNode;
}

export function Button({
  variant,
  size,
  block,
  busy = false,
  icon,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled === true || busy}
      aria-busy={busy || undefined}
      className={cx(buttonStyle({ variant, size, block }), className)}
    >
      {icon !== undefined && <Icon name={icon} />}
      {children}
    </button>
  );
}

const ICON_VARIANTS: Record<Exclude<KitButtonVariant, 'danger'>, string> = {
  primary: VARIANTS.primary,
  secondary: VARIANTS.secondary,
  quiet: 'bg-transparent text-ink hover:bg-surface-2',
};

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: IconName;
  /** What the button does, for screen readers (it has no visible text). */
  label: string;
  variant?: Exclude<KitButtonVariant, 'danger'>;
}

export function IconButton({
  icon,
  label,
  variant = 'quiet',
  className,
  type = 'button',
  ...rest
}: IconButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      aria-label={label}
      className={cx(BASE, ICON_VARIANTS[variant], 'size-11 shrink-0 p-0', className)}
    >
      <Icon name={icon} />
    </button>
  );
}
