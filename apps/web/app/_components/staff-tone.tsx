import { cx } from '@pepper/ui';
import type { StaffTone } from '../../lib/calendar';

// A staff member's tone (DESIGN.md §3): the soft fill and 4 px bar of their calendar blocks,
// and the dot beside their name elsewhere (the staff filter, the Team list). The name is always
// shown too: never color alone.
export const STAFF_TONE_CLASSES: Record<StaffTone, { block: string; dot: string }> = {
  brand: { block: 'bg-brand-soft border-brand', dot: 'bg-brand' },
  accent: { block: 'bg-accent-soft border-accent', dot: 'bg-accent' },
  info: { block: 'bg-info-soft border-info', dot: 'bg-info' },
};

/** The dot of a member's tone, hidden from screen readers (their name says who). */
export function StaffToneDot({
  tone,
  className,
}: {
  tone: StaffTone;
  className?: string | undefined;
}) {
  return (
    <span
      aria-hidden="true"
      className={cx('size-3 shrink-0 rounded-pill', STAFF_TONE_CLASSES[tone].dot, className)}
    />
  );
}
