import { OperatorPublicRequestSchema } from '@pepper/contracts';
import { PlainLink } from '../../../_components/help/help-link';
import { OpsRequestView } from '../../../_components/ops/ops-request';
import { OPS_PATHS } from '../../../../lib/ops';
import { currentJson } from '../../../_server/account';

export const dynamic = 'force-dynamic';

/** A request from the public form (S59.2, AC-X-21); opening it is logged. */
export default async function OpsRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const request = await currentJson(
    `/v1/ops/requests/${encodeURIComponent(id)}`,
    OperatorPublicRequestSchema,
  );
  return (
    <>
      <PlainLink href={OPS_PATHS.inbox} back>
        Inbox
      </PlainLink>
      {request === null ? (
        <p role="alert" className="m-0 rounded-md bg-warn-soft px-4 py-3 type-label text-warn">
          I couldn’t open this request.
        </p>
      ) : (
        <OpsRequestView initial={request} />
      )}
    </>
  );
}
