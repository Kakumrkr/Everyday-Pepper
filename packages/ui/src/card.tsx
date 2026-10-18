import type { ReactNode } from 'react';
import { cx } from './class-names.js';

/** A content card: surface, line border, large radius; no shadow (only floating things have one). */
export function Card({
  children,
  className,
  as: Tag = 'section',
}: {
  children: ReactNode;
  className?: string | undefined;
  as?: 'section' | 'div' | 'article';
}) {
  return (
    <Tag className={cx('rounded-lg border border-line bg-surface p-5', className)}>{children}</Tag>
  );
}
