import type { ReactNode } from 'react';
import { cx } from '../class-names.js';
import { Icon, type IconName } from '../icons.js';
import { Button, FOCUS_RING, buttonStyle } from './button.js';

// Content blocks of the kit (DESIGN.md §4). The one idea: a raised `Card` means "this needs
// you"; everything else is a quiet hairline `ListRow` (§2).

/** A link the screen renders (Next's `Link` in the app; a plain anchor by default). */
export type KitLink = (props: {
  href: string;
  className: string;
  children: ReactNode;
  'aria-current'?: 'page' | undefined;
}) => ReactNode;

const plainLink: KitLink = ({ href, className, children, ...rest }) => (
  <a href={href} className={className} {...rest}>
    {children}
  </a>
);

/** A decision card: raised, and only for something that needs the owner's decision. */
export function Card({
  children,
  labelledBy,
  className,
}: {
  children: ReactNode;
  /** The id of the card's heading, which names it as a region. */
  labelledBy: string;
  className?: string | undefined;
}) {
  return (
    <section
      aria-labelledby={labelledBy}
      className={cx('rounded-lg bg-surface p-5 shadow-raised', className)}
    >
      {children}
    </section>
  );
}

/** Hairline rows (`ListRow`s) in a list. */
export function List({
  children,
  label,
  className,
}: {
  children: ReactNode;
  /** What the list holds, for screen readers when no heading names it. */
  label?: string | undefined;
  className?: string | undefined;
}) {
  return (
    <ul aria-label={label} className={cx('m-0 list-none divide-y divide-line p-0', className)}>
      {children}
    </ul>
  );
}

export interface ListRowProps {
  title: ReactNode;
  /** A second line: the service, who, a source. */
  meta?: ReactNode;
  /** A time ("9:45") or an icon before the title. */
  leading?: ReactNode;
  /**
   * An amount or a badge after it; an action only on a row without `href` (the linked row is
   * one link, and a button can't sit inside it).
   */
  trailing?: ReactNode;
  /** The row opens this (a chevron shows it navigates). */
  href?: string | undefined;
  renderLink?: KitLink | undefined;
}

/** A quiet row with a hairline under it; with `href`, the whole row is the link. */
export function ListRow({
  title,
  meta,
  leading,
  trailing,
  href,
  renderLink = plainLink,
}: ListRowProps) {
  const body = (
    <>
      {leading !== undefined && (
        <span className="w-14 shrink-0 type-caption text-ink-2 tabular-nums">{leading}</span>
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate type-body font-semibold text-ink">{title}</span>
        {meta !== undefined && <span className="type-caption text-ink-2">{meta}</span>}
      </span>
      {trailing !== undefined && <span className="shrink-0">{trailing}</span>}
      {href !== undefined && <Icon name="right" className="text-ink-3" />}
    </>
  );
  const row = 'flex min-h-14 items-center gap-3 py-3';
  return (
    <li>
      {href === undefined ? (
        <div className={row}>{body}</div>
      ) : (
        renderLink({
          href,
          className: cx(row, '-mx-2 rounded-sm px-2 no-underline hover:bg-surface-2', FOCUS_RING),
          children: body,
        })
      )}
    </li>
  );
}

/** Labelled facts with hairlines between: Time · Service · Who's told · Then. */
export function DetailTable({
  rows,
  className,
}: {
  rows: readonly { label: string; value: ReactNode }[];
  className?: string | undefined;
}) {
  return (
    <dl className={cx('m-0 divide-y divide-line', className)}>
      {rows.map(({ label, value }) => (
        <div key={label} className="grid grid-cols-[7rem_1fr] gap-3 py-3">
          <dt className="type-label text-ink-2">{label}</dt>
          <dd className="m-0 type-body text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A number with its label. One `xl` per screen: the number that matters most (DESIGN.md §2). */
export function Stat({
  value,
  label,
  size = 'md',
  className,
}: {
  value: string;
  label: string;
  size?: 'xl' | 'md';
  className?: string | undefined;
}) {
  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <span
        className={cx('text-ink tabular-nums', size === 'xl' ? 'type-number-xl' : 'type-title')}
      >
        {value}
      </span>
      <span className="type-label text-ink-2">{label}</span>
    </div>
  );
}

export type EmptyAction =
  | { label: string; href: string; renderLink?: KitLink | undefined }
  | { label: string; onClick: () => void };

/** An empty screen or list says what to do next, with the action (D5): `action` is required. */
export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: IconName | undefined;
  title: string;
  body: string;
  action: EmptyAction;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg bg-surface-2 px-6 py-10 text-center">
      {icon !== undefined && (
        <span className="inline-flex size-12 items-center justify-center rounded-pill bg-surface text-brand">
          <Icon name={icon} className="size-6" />
        </span>
      )}
      <p className="m-0 type-subheading text-ink">{title}</p>
      <p className="m-0 max-w-xs type-body text-ink-2">{body}</p>
      {'href' in action ? (
        (action.renderLink ?? plainLink)({
          href: action.href,
          className: cx(buttonStyle({ variant: 'primary' }), 'mt-2'),
          children: action.label,
        })
      ) : (
        <Button className="mt-2" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}

/** What Pepper just did, on an `ok-soft` strip, with Undo while it can be undone. */
export function Receipt({
  children,
  undo,
}: {
  children: ReactNode;
  undo?: { onUndo: () => void; until: string } | undefined;
}) {
  return (
    <div role="status" className="flex items-center gap-3 rounded-md bg-ok-soft px-4 py-3">
      <Icon name="check" className="text-ok" />
      <p className="m-0 flex-1 type-body text-ink">{children}</p>
      {undo !== undefined && (
        <button
          type="button"
          onClick={undo.onUndo}
          className={cx(
            'inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-pill bg-transparent px-3 py-0 type-label text-ok hover:bg-surface',
            FOCUS_RING,
          )}
        >
          <Icon name="undo" className="size-4" />
          Undo
          <span className="sr-only">, until {undo.until}</span>
        </button>
      )}
    </div>
  );
}

/** The classes of a pressable chip (a time, a filter); `selected` marks the chosen one. */
export function chipStyle(selected: boolean): string {
  return cx(
    'min-h-11 rounded-md border px-4 py-0 type-label tabular-nums transition motion-fast ease-standard',
    'disabled:cursor-not-allowed disabled:opacity-50',
    selected
      ? 'border-brand bg-brand text-brand-ink'
      : 'border-line-strong bg-surface text-ink hover:bg-surface-2',
    FOCUS_RING,
  );
}

/** A time to pick ("4:15"); `selected` marks the chosen one. */
export function TimeChip({
  time,
  selected = false,
  disabled = false,
  onSelect,
}: {
  time: string;
  selected?: boolean;
  /** While the choice is being booked, so it can't be pressed twice. */
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onSelect}
      className={chipStyle(selected)}
    >
      {time}
    </button>
  );
}

/** Where the client is in the booking: one segment per step, the current one named. */
export function StepBar({ steps, current: asked }: { steps: readonly string[]; current: number }) {
  const current = Math.min(Math.max(0, Math.trunc(asked)), steps.length - 1);
  const name = steps[current] ?? '';
  return (
    <div className="flex flex-col gap-2">
      <ol aria-label="Booking steps" className="m-0 flex list-none gap-1.5 p-0">
        {steps.map((step, index) => (
          <li
            // By position: two steps may share a label.
            key={index}
            aria-current={index === current ? 'step' : undefined}
            className={cx(
              'h-1.5 flex-1 rounded-pill',
              index <= current ? 'bg-brand' : 'bg-surface-2',
            )}
          >
            <span className="sr-only">
              {step}
              {index < current ? ', done' : ''}
            </span>
          </li>
        ))}
      </ol>
      <p className="m-0 type-caption text-ink-2" aria-hidden="true">
        Step {current + 1} of {steps.length} · {name}
      </p>
    </div>
  );
}

/** The bottom bar with the summary, Back and the one primary action, within thumb reach (D3). */
export function StickyActionBar({
  summary,
  back,
  primary,
  placement = 'fixed',
}: {
  summary: ReactNode;
  back?: { label: string; onClick: () => void } | undefined;
  primary: ReactNode;
  /** `inline` shows it in place (the gallery). */
  placement?: 'fixed' | 'inline';
}) {
  const content = (
    <>
      <div className="min-w-0 flex-1 type-label text-ink">{summary}</div>
      {back !== undefined && (
        <Button variant="secondary" onClick={back.onClick}>
          {back.label}
        </Button>
      )}
      {primary}
    </>
  );
  const bar = 'bg-surface px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-floating';
  return placement === 'fixed' ? (
    <div className={cx(bar, 'fixed inset-x-0 bottom-0 z-20')}>
      {/* On a wide screen, as wide as the page it ends: summary and action stay together. */}
      <div className="mx-auto flex w-full max-w-lg items-center gap-3">{content}</div>
    </div>
  ) : (
    <div className={cx(bar, 'flex items-center gap-3 rounded-lg')}>{content}</div>
  );
}

/** The morning briefing: the day's number, how full the day is, and a few lines. */
export function BriefingBlock({
  greeting,
  value,
  valueLabel,
  progress,
  progressLabel,
  children,
}: {
  greeting: string;
  value: string;
  valueLabel: string;
  /** 0–1: how full the day is. */
  progress: number;
  progressLabel: string;
  children?: ReactNode;
}) {
  const percent = Number.isFinite(progress)
    ? Math.round(Math.min(1, Math.max(0, progress)) * 100)
    : 0;
  return (
    <section
      aria-label={greeting}
      className="flex flex-col gap-4 rounded-xl bg-brand p-6 text-brand-ink"
    >
      <p className="m-0 type-heading">{greeting}</p>
      <div className="flex flex-col gap-1">
        <span className="type-number-xl tabular-nums">{value}</span>
        <span className="type-label">{valueLabel}</span>
      </div>
      <div className="flex flex-col gap-1.5">
        <div
          role="progressbar"
          aria-label={progressLabel}
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          className="h-2 overflow-hidden rounded-pill bg-brand-ink/25"
        >
          <div className="h-full rounded-pill bg-accent" style={{ width: `${String(percent)}%` }} />
        </div>
        <span className="type-caption">{progressLabel}</span>
      </div>
      {children}
    </section>
  );
}

export interface TabItem {
  key: string;
  label: string;
  icon: IconName;
  href: string;
}

/** The phone's bottom tabs: Home · Calendar · Clients · Chat · More; the current in a pill. */
export function BottomTabBar({
  items,
  current,
  renderLink = plainLink,
  placement = 'fixed',
}: {
  items: readonly TabItem[];
  current: string;
  renderLink?: KitLink | undefined;
  /** `inline` shows it in place (the gallery). */
  placement?: 'fixed' | 'inline';
}) {
  return (
    <nav
      aria-label="Main"
      className={cx(
        'border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]',
        placement === 'fixed' && 'fixed inset-x-0 bottom-0 z-20',
      )}
    >
      <ul className="m-0 flex list-none p-0">
        {items.map((item) => {
          const active = item.key === current;
          return (
            <li key={item.key} className="flex-1">
              {renderLink({
                href: item.href,
                'aria-current': active ? 'page' : undefined,
                className: cx(
                  'flex min-h-tab-item flex-col items-center justify-center gap-0.5 no-underline type-caption',
                  active ? 'text-ink' : 'text-ink-2',
                  FOCUS_RING,
                ),
                children: (
                  <>
                    <span
                      className={cx(
                        'inline-flex h-7.5 w-13 items-center justify-center rounded-pill',
                        active && 'bg-brand-soft text-brand',
                      )}
                    >
                      <Icon name={item.icon} />
                    </span>
                    {item.label}
                  </>
                ),
              })}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
