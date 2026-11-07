import { OperatorThreadSchema, SupportSavedReplyListSchema } from '@pepper/contracts';
import { PlainLink } from '../../../_components/help/help-link';
import { OpsThreadView } from '../../../_components/ops/ops-thread';
import { OPS_PATHS } from '../../../../lib/ops';
import { currentJson } from '../../../_server/account';

export const dynamic = 'force-dynamic';

/**
 * A business's request (S59.2, AC-X-21/22); opening it is logged and marks it seen. The team's
 * saved replies come along for the reply box (S59.2.2, AC-X-23); without them it still opens.
 */
export default async function OpsThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [thread, saved] = await Promise.all([
    currentJson(`/v1/ops/threads/${encodeURIComponent(id)}`, OperatorThreadSchema),
    currentJson('/v1/ops/replies', SupportSavedReplyListSchema),
  ]);
  return (
    <>
      <PlainLink href={OPS_PATHS.inbox} back>
        Inbox
      </PlainLink>
      {thread === null ? (
        <p role="alert" className="m-0 rounded-md bg-warn-soft px-4 py-3 type-label text-warn">
          I couldn’t open this request. It may have gone with its business.
        </p>
      ) : (
        <OpsThreadView initial={thread} savedReplies={saved?.replies ?? []} />
      )}
    </>
  );
}
