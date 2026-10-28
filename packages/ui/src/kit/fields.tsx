import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cx } from '../class-names.js';
import { Icon } from '../icons.js';
import { FOCUS_RING } from './button.js';

// Form fields of the kit (DESIGN.md §4): a visible label on every field, a hint and an error
// tied to it for screen readers, `line-strong` borders (3:1, D2) and 48 px tall controls.

const CONTROL =
  'w-full rounded-md border border-line-strong bg-surface px-4 text-ink type-body ' +
  'placeholder:text-ink-3 disabled:opacity-50 aria-invalid:border-danger ' +
  FOCUS_RING;

/**
 * The kit's control look for a field that keeps its own label and layout (a card's inline
 * editor): add `min-h-12` for one line, `py-3` and a height for several (S41).
 */
export const fieldStyle = CONTROL;

interface FieldProps {
  /** The visible label. */
  label: string;
  /** A line under the label: an example or what the field is for. */
  hint?: string | undefined;
  /** What is wrong and what to do (copy rules, DESIGN.md §6). */
  error?: string | undefined;
}

/** The label, hint and error around a control; `children` gets the ids to use. */
function Field({
  label,
  hint,
  error,
  children,
}: FieldProps & {
  children: (ids: { id: string; describedBy: string | undefined }) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [hint === undefined ? null : hintId, error === undefined ? null : errorId]
      .filter(Boolean)
      .join(' ') || undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="type-label text-ink">
        {label}
      </label>
      {hint !== undefined && (
        <p id={hintId} className="m-0 type-caption text-ink-2">
          {hint}
        </p>
      )}
      {children({ id, describedBy })}
      {error !== undefined && (
        <p id={errorId} className="m-0 flex items-center gap-1.5 type-caption text-danger">
          <Icon name="alert" className="size-4" />
          {error}
        </p>
      )}
    </div>
  );
}

export type InputProps = FieldProps & Omit<InputHTMLAttributes<HTMLInputElement>, 'id'>;

export function Input({ label, hint, error, className, ...rest }: InputProps) {
  return (
    <Field label={label} hint={hint} error={error}>
      {({ id, describedBy }) => (
        <input
          {...rest}
          id={id}
          aria-describedby={describedBy}
          aria-invalid={error !== undefined || undefined}
          className={cx(CONTROL, 'min-h-12', className)}
        />
      )}
    </Field>
  );
}

export type TextareaProps = FieldProps & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'>;

export function Textarea({ label, hint, error, className, rows = 3, ...rest }: TextareaProps) {
  return (
    <Field label={label} hint={hint} error={error}>
      {({ id, describedBy }) => (
        <textarea
          {...rest}
          id={id}
          rows={rows}
          aria-describedby={describedBy}
          aria-invalid={error !== undefined || undefined}
          className={cx(CONTROL, 'py-3', className)}
        />
      )}
    </Field>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

export type SelectProps = FieldProps &
  Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id' | 'children'> & {
    options: readonly SelectOption[];
  };

/** A native select: the phone's own picker, the kit's look. */
export function Select({ label, hint, error, options, className, ...rest }: SelectProps) {
  return (
    <Field label={label} hint={hint} error={error}>
      {({ id, describedBy }) => (
        <div className="relative">
          <select
            {...rest}
            id={id}
            aria-describedby={describedBy}
            aria-invalid={error !== undefined || undefined}
            className={cx(CONTROL, 'min-h-12 appearance-none pr-11', className)}
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <Icon
            name="down"
            className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-ink-2"
          />
        </div>
      )}
    </Field>
  );
}

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'id'> & {
  label: string;
  hint?: string | undefined;
};

/** A checkbox whose whole row (box and label) is the tap target (D3); the hint sits below. */
export function Checkbox({ label, hint, className, ...rest }: CheckboxProps) {
  const id = useId();
  return (
    <div className={cx('flex flex-col', className)}>
      <label className="flex min-h-11 cursor-pointer items-start gap-3 py-2.5 type-body text-ink">
        <input
          {...rest}
          id={id}
          type="checkbox"
          aria-describedby={hint === undefined ? undefined : `${id}-hint`}
          className={cx(
            'mt-0.5 size-6 min-h-0 shrink-0 cursor-pointer p-0 accent-brand',
            FOCUS_RING,
          )}
        />
        {label}
      </label>
      {hint !== undefined && (
        <p id={`${id}-hint`} className="m-0 -mt-2 mb-1 pl-9 type-caption text-ink-2">
          {hint}
        </p>
      )}
    </div>
  );
}

export type SwitchProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'id' | 'role'> & {
  label: string;
  hint?: string | undefined;
};

/** An on/off setting that takes effect at once (a checkbox with the switch role). */
export function Switch({ label, hint, className, ...rest }: SwitchProps) {
  const id = useId();
  return (
    <div className={cx('flex min-h-11 items-center justify-between gap-4 py-2', className)}>
      <div className="flex flex-col gap-0.5">
        <label htmlFor={id} className="cursor-pointer type-body text-ink">
          {label}
        </label>
        {hint !== undefined && (
          <p id={`${id}-hint`} className="m-0 type-caption text-ink-2">
            {hint}
          </p>
        )}
      </div>
      <span className="relative inline-flex shrink-0">
        <input
          {...rest}
          id={id}
          type="checkbox"
          role="switch"
          aria-describedby={hint === undefined ? undefined : `${id}-hint`}
          className="peer absolute inset-0 z-10 m-0 size-full min-h-0 cursor-pointer p-0 opacity-0"
        />
        <span
          aria-hidden="true"
          className={cx(
            'h-8 w-13 rounded-pill border border-line-strong bg-surface-2 transition motion-fast ease-standard',
            'peer-checked:border-brand peer-checked:bg-brand',
            'peer-focus-visible:outline-3 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand',
            'peer-disabled:opacity-50',
          )}
        />
        <span
          aria-hidden="true"
          className={cx(
            'pointer-events-none absolute top-1 left-1 size-6 rounded-pill bg-line-strong shadow-raised',
            'transition motion-fast ease-standard peer-checked:translate-x-5 peer-checked:bg-brand-ink',
          )}
        />
      </span>
    </div>
  );
}
