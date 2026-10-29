'use client';

import type { TemplateId, TemplateSummary } from '@pepper/contracts';
import { cx, Icon } from '@pepper/ui';
import { useId, useState, type Ref } from 'react';

/**
 * The business type on the create-business screen (S45, ADR-0046, AC-W1-8): the four V1 types
 * as one-tap tiles, the others under "More types". Each tile says what it starts with; the
 * choice pre-fills the menu, the owner's hours and Pepper's words. A radio group (arrow keys
 * move), its error under it like every kit field (DESIGN.md §4).
 */
export function BusinessTypePicker({
  types,
  value,
  error,
  onChange,
  firstRef,
}: {
  types: readonly TemplateSummary[];
  value: TemplateId | null;
  error?: string | undefined;
  onChange: (id: TemplateId) => void;
  /** The first tile, for focusing the group when it has an error. */
  firstRef?: Ref<HTMLInputElement>;
}) {
  const id = useId();
  const featured = types.filter((t) => t.featured);
  const others = types.filter((t) => !t.featured);
  const [showMore, setShowMore] = useState(
    () => value !== null && others.some((t) => t.id === value),
  );
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const moreId = `${id}-more`;
  const describedBy = error === undefined ? hintId : `${hintId} ${errorId}`;

  const tile = (type: TemplateSummary, index: number) => (
    <label
      key={type.id}
      className={cx(
        'relative flex min-h-16 cursor-pointer flex-col justify-center gap-0.5 rounded-md border px-4 py-3',
        'transition motion-base ease-standard',
        'has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand',
        value === type.id
          ? 'border-brand bg-brand-soft'
          : 'border-line-strong bg-surface hover:bg-surface-2',
      )}
    >
      <input
        ref={index === 0 ? firstRef : undefined}
        type="radio"
        name="templateId"
        value={type.id}
        checked={value === type.id}
        onChange={() => {
          onChange(type.id);
        }}
        className="sr-only"
      />
      <span className="pr-6 type-label text-ink">{type.name}</span>
      <span className="type-caption text-ink-2">{type.serviceCount} services</span>
      {value === type.id ? (
        <Icon name="check" className="absolute top-3 right-3 size-5 text-brand" />
      ) : null}
    </label>
  );

  return (
    <div className="flex flex-col gap-1.5">
      <span id={labelId} className="type-label text-ink">
        Type of business
      </span>
      <p id={hintId} className="m-0 type-caption text-ink-2">
        We set up your menu, prices and opening hours from it. You can change all of it.
      </p>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        aria-describedby={describedBy}
        aria-invalid={error !== undefined || undefined}
        className="flex flex-col gap-2"
      >
        <div className="grid grid-cols-2 gap-2">{featured.map(tile)}</div>
        {others.length === 0 ? null : (
          <>
            <button
              type="button"
              aria-expanded={showMore}
              aria-controls={moreId}
              onClick={() => {
                setShowMore((open) => !open);
              }}
              className={cx(
                'flex min-h-11 cursor-pointer items-center gap-1.5 self-start rounded-sm bg-transparent px-1 type-label text-brand',
                'focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-brand',
              )}
            >
              More types
              <Icon
                name="down"
                className={cx('size-4 transition motion-base', showMore && 'rotate-180')}
              />
            </button>
            <div id={moreId} hidden={!showMore} className="grid grid-cols-2 gap-2">
              {others.map((type) => tile(type, -1))}
            </div>
          </>
        )}
      </div>
      {error === undefined ? null : (
        <p id={errorId} className="m-0 flex items-center gap-1.5 type-caption text-danger">
          <Icon name="alert" className="size-4" />
          {error}
        </p>
      )}
    </div>
  );
}
