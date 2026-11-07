import type { SupportScreenshot, SupportScreenshotSize } from '@pepper/contracts';
import { cx, FOCUS_RING } from '@pepper/ui';

// A message's screenshots (S59.2.3, AC-X-27/30): thumbnails that open the full image in a new
// tab, in the order they were sent. The member's thread and the console use it, each with its own
// address (the console's reads are logged).

const THUMB_HEIGHT = 112;
const THUMB_MAX_WIDTH = 224;

export function MessageScreenshots({
  screenshots,
  from,
  src,
  align = 'start',
}: {
  screenshots: readonly SupportScreenshot[];
  /** Who sent them, for the images' names ("You", "Jess"). */
  from: string;
  src: (id: string, size: SupportScreenshotSize) => string;
  align?: 'start' | 'end';
}) {
  if (screenshots.length === 0) return null;
  return (
    <ul
      className={cx(
        'm-0 flex list-none flex-wrap gap-2 p-0',
        align === 'end' ? 'justify-end' : 'justify-start',
      )}
      aria-label={
        screenshots.length === 1 ? 'Screenshot' : `${String(screenshots.length)} screenshots`
      }
      data-testid="message-screenshots"
    >
      {screenshots.map((shot, index) => {
        const width = Math.min(
          THUMB_MAX_WIDTH,
          Math.max(1, Math.round((THUMB_HEIGHT * shot.width) / shot.height)),
        );
        return (
          <li key={shot.id}>
            <a
              href={src(shot.id, 'full')}
              target="_blank"
              rel="noopener noreferrer"
              className={cx('block rounded-sm', FOCUS_RING)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- private, uncached images from the api: not for Next's optimiser */}
              <img
                src={src(shot.id, 'thumb')}
                width={width}
                height={THUMB_HEIGHT}
                alt={`Screenshot ${String(index + 1)} of ${String(screenshots.length)} from ${from}, opens full size`}
                className="block h-28 w-auto max-w-56 rounded-sm border border-line bg-surface-2 object-contain"
              />
            </a>
          </li>
        );
      })}
    </ul>
  );
}
