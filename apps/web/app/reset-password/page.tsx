import type { Metadata } from 'next';
import { NewPasswordForm, ResetLinkExpired } from '../_components/password-reset';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Choose a new password · Pepper',
  // The address carries the reset token: never send it on to another site.
  referrer: 'no-referrer',
};

/**
 * Where a reset link lands (S44, AC-W1-4): Better Auth checks the token and sends the browser
 * here with it, or with `error` when the link was used or has run out.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token, error } = await searchParams;
  if (typeof token !== 'string' || token === '' || error !== undefined) {
    return <ResetLinkExpired />;
  }
  return <NewPasswordForm token={token} />;
}
