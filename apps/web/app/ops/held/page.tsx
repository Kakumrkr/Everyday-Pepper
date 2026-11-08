import { OperatorHeldListSchema } from '@pepper/contracts';
import { PlainLink } from '../../_components/help/help-link';
import { OpsHeldList } from '../../_components/ops/ops-held';
import { OPS_PATHS } from '../../../lib/ops';
import { currentJson } from '../../_server/account';

export const dynamic = 'force-dynamic';

/**
 * Held mail (S59.3.2, AC-X-44): emails whose sender couldn't be verified, or who may not write
 * where they wrote, the longest waiting first. Each is kept 7 days; opening the list is logged.
 */
export default async function OpsHeldPage() {
  const held = await currentJson('/v1/ops/held', OperatorHeldListSchema);
  return (
    <>
      <PlainLink href={OPS_PATHS.inbox} back>
        Inbox
      </PlainLink>
      <header className="flex flex-col gap-2">
        <h1 className="m-0 type-display">Held mail</h1>
        <p className="m-0 type-body text-ink-2">
          Emails we couldn’t check. Accept only one you know is from who it says: it lands as
          theirs, as if it had passed. Discard the rest. Each is kept 7 days.
        </p>
      </header>
      {held === null ? (
        <p role="alert" className="m-0 rounded-md bg-warn-soft px-4 py-3 type-label text-warn">
          I couldn’t read held mail right now. Try again in a moment.
        </p>
      ) : (
        <OpsHeldList initial={held} />
      )}
    </>
  );
}
