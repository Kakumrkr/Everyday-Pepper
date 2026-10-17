import type { Metadata } from 'next';
import { InviteAcceptance } from '../_components/invite-acceptance';
import { Unavailable } from '../_components/unavailable';
import { currentAccount } from '../_server/account';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Join a business · Floty' };

/**
 * Where an invite link leads (`/invite#<token>`). The token never reaches this server: the
 * page reads it in the browser, then asks the api about it once the visitor is signed in.
 */
export default async function InvitePage() {
  const account = await currentAccount();
  if (account.state === 'unavailable') return <Unavailable />;
  return (
    <main>
      <h1 className="wordmark">floty</h1>
      <InviteAcceptance email={account.state === 'signed-in' ? account.me.user.email : null} />
    </main>
  );
}
