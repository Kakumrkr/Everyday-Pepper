import { HelpArticleSlugSchema } from '@pepper/contracts';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { HELP_PATH } from '../../../lib/help';
import { newRequestHref } from '../../../lib/support';
import { PlainLink } from '../../_components/help/help-link';
import { PublicSupportForm } from '../../_components/help/public-support-form';
import { currentAccount } from '../../_server/account';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Write to us · Pepper help' };

type Query = Record<string, string | string[] | undefined>;

/**
 * Write to the Pepper team without signing in (S59, PCR-010, AC-X-17): for people who can't
 * sign in, or haven't signed up. Someone signed in gets the app's form, which keeps a thread.
 */
export default async function HelpContactPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const raw = query['topic'];
  const topic = HelpArticleSlugSchema.safeParse(raw).success ? (raw as string) : null;
  if ((await currentAccount()).state === 'signed-in') {
    redirect(newRequestHref({ page: '/help/contact', ...(topic !== null && { topic }) }));
  }
  return (
    <>
      <PlainLink href={HELP_PATH} back>
        All help
      </PlainLink>
      <header className="flex flex-col gap-2">
        <h1 className="m-0 type-display">Write to us</h1>
        <p className="m-0 type-body text-ink-2">
          Can’t sign in, or not signed up yet? Tell us here. A person on the Pepper team answers by
          email, the same day.
        </p>
      </header>
      <PublicSupportForm topic={topic} />
    </>
  );
}
