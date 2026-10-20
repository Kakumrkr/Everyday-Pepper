import type { ReactNode } from 'react';
import { cx } from './class-names.js';

/** A content card: surface, line border, large radius; no shadow (only floating things have one). */
export function Card({
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
