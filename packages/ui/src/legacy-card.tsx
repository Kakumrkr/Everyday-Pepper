import type { ReactNode } from 'react';
import { cx } from './class-names.js';

/**
 * The card screens built before S40 use: surface, line border, large radius, no shadow. S41–S43
 * move them onto the kit (a raised `Card` for decisions, `ListRow`s for the rest) and delete it.
 */
export function LegacyCard({
  children,
  className,
  as: Tag = 'section',
  labelledBy,
}: {
  children: ReactNode;
  className?: string | undefined;
  as?: 'section' | 'div' | 'article';
  /** The id of the card's heading, which names it (a section then becomes a region). */
  labelledBy?: string | undefined;
}) {
  return (
    <Tag
      aria-labelledby={labelledBy}
      className={cx('rounded-lg border border-line bg-surface p-5', className)}
    >
      {children}
    </Tag>
  );
}
