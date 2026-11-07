import { SupportThreadSchema } from '@pepper/contracts';
import type { Metadata } from 'next';
import { SUPPORT_PATHS } from '../../../../lib/support';
import { PlainLink } from '../../../_components/help/help-link';
import { SupportThreadView } from '../../../_components/support/support-thread';
import { currentAccount, currentBusiness, currentJson } from '../../../_server/account';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Your request · Pepper' };

/**
 * One support request (S59, PCR-010, AC-X-15/16): its messages in order, a reply, "Mark as
 * solved". Opening it marks Pepper's answers read. Another's request, or one of another
 * business, is not found.
 */
export default async function SupportThreadPage({
  params,
}: {
  params: Promise<{ threadId: string }>;
}) {
  // The app layout has sent anyone without a usable session elsewhere already.
  const account = await currentAccount();
  if (account.state !== 'signed-in') return null;
  const current = await currentBusiness();
  const { threadId } = await params;
  const thread =
    current === null
      ? null
      : await currentJson(
          `/v1/support/threads/${encodeURIComponent(threadId)}`,
          SupportThreadSchema,
        );
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-5">
      <PlainLink href={SUPPORT_PATHS.list} back>
        Your requests
      </PlainLink>
      {thread === null ? (
        <div className="flex flex-col gap-2">
          <h1 className="m-0 type-display">I couldn’t open this request</h1>
          <p className="m-0 type-body text-ink-2">
            Try again in a moment. If it still doesn’t open, it may be someone else’s on your team,
            or another business’s: your own are all in Your requests.
          </p>
        </div>
      ) : (
        <SupportThreadView initial={thread} timeZone={current?.business.timeZone ?? 'UTC'} />
      )}
    </div>
  );
}
