import { HELP_CONTACT_PATH } from '../../lib/help';
import { newRequestHref } from '../../lib/support';
import { TextLink } from '../_components/auth-page';
import { HelpSearch } from '../_components/help/help-search';
import { currentAccount } from '../_server/account';

// Per request: "ask us" goes to the app's form when signed in, the public one otherwise.
export const dynamic = 'force-dynamic';

/** The help centre (S59, PCR-010, AC-X-13): every article by topic, with a search. */
export default async function HelpPage() {
  const signedIn = (await currentAccount()).state === 'signed-in';
  const askHref = signedIn ? newRequestHref({ page: '/help' }) : HELP_CONTACT_PATH;
  return (
    <>
      <header className="flex flex-col gap-2">
        <h1 className="m-0 type-display">How can we help?</h1>
        <p className="m-0 type-body text-ink-2">
          Short answers to the common questions. Can’t find yours?{' '}
          <TextLink href={askHref}>Ask us</TextLink>: a person answers the same day.
        </p>
      </header>
      <HelpSearch askHref={askHref} />
    </>
  );
}
