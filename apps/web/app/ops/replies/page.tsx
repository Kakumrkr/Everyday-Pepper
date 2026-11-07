import { SupportSavedReplyListSchema } from '@pepper/contracts';
import { PlainLink } from '../../_components/help/help-link';
import { OpsSavedReplies } from '../../_components/ops/ops-saved-replies';
import { OPS_PATHS } from '../../../lib/ops';
import { currentJson } from '../../_server/account';

export const dynamic = 'force-dynamic';

/** The team's saved replies (S59.2.2, AC-X-23); reading them is logged like any console access. */
export default async function OpsRepliesPage() {
  const saved = await currentJson('/v1/ops/replies', SupportSavedReplyListSchema);
  return (
    <>
      <PlainLink href={OPS_PATHS.inbox} back>
        Inbox
      </PlainLink>
      {saved === null ? (
        <p role="alert" className="m-0 rounded-md bg-warn-soft px-4 py-3 type-label text-warn">
          I couldn’t read the saved replies right now. Try again in a moment.
        </p>
      ) : (
        <OpsSavedReplies initial={saved.replies} />
      )}
    </>
  );
}
