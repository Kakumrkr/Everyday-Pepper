import { cx, FOCUS_RING, Icon } from '@pepper/ui';
import Link from 'next/link';
import { helpHref, type HELP_LINKS } from '../../../lib/help';

/**
 * A screen's way to its help article (S59, AC-X-13): a quiet "How this works" with the help
 * mark, a 44 px tap target. The slug is one of `HELP_LINKS`, each checked to name an article.
 */
export function HelpLink({
  article,
  children = 'How this works',
}: {
  article: (typeof HELP_LINKS)[keyof typeof HELP_LINKS];
  children?: string;
}) {
  return (
    <Link
      href={helpHref(article)}
      className={cx(
        'inline-flex min-h-11 items-center gap-1.5 self-start type-label text-brand no-underline hover:underline',
        FOCUS_RING,
      )}
    >
      <Icon name="help" className="shrink-0" />
      {children}
    </Link>
  );
}

/** A way back or across on its own line ("‹ All help"): a 44 px tap target, as D3 asks. */
export function PlainLink({
  href,
  back = false,
  children,
}: {
  href: string;
  back?: boolean;
  children: string;
}) {
  return (
    <Link
      href={href}
      className={cx(
        'inline-flex min-h-11 items-center self-start type-label text-brand underline-offset-4 hover:underline',
        back && '-ml-2 rounded-pill px-2',
        FOCUS_RING,
      )}
    >
      {back ? <span aria-hidden="true">‹&nbsp;</span> : null}
      {children}
    </Link>
  );
}
