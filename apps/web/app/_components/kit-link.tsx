import type { KitLink } from '@pepper/ui';
import Link from 'next/link';

/** The kit's links as Next links (client-side navigation inside the app). */
export const kitLink: KitLink = ({ href, className, children, ...rest }) => (
  <Link href={href} className={className} {...rest}>
    {children}
  </Link>
);
