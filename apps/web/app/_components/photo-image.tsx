import type { ImgHTMLAttributes } from 'react';

/**
 * A booking page photo (S47.2, ADR-0048). The api already serves each one resized, as WebP,
 * cached as unchanging on the app's own origin, with a `srcset` of its widths: Next's image
 * optimizer would only fetch and re-encode it again, so a plain `img` is used, lazy unless
 * asked otherwise, with its size given so the page doesn't jump while it loads.
 */
export function PhotoImage({
  alt,
  loading = 'lazy',
  ...rest
}: ImgHTMLAttributes<HTMLImageElement> & { alt: string; width: number; height: number }) {
  // eslint-disable-next-line @next/next/no-img-element -- resized and cached by the api (above)
  return <img alt={alt} loading={loading} decoding="async" {...rest} />;
}
