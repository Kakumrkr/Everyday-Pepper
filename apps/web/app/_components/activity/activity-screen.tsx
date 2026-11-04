'use client';

import {
  AiActionsResponseSchema,
  UndoActionResponseSchema,
  UndoRefusedBodySchema,
  type AiActionsResponse,
} from '@pepper/contracts';
import { ActivityLog } from '@pepper/ui';
import { fetchJson, sendJson } from '../../../lib/client-api';
import { UNDO_REFUSAL } from '../chat/live-change';

/** How many receipts a page of the log holds. */
export const ACTIVITY_PAGE = 20;

/**
 * The Activity log in the app (S52, AC-W7-4): "Show older" reads the next page of
 * `/v1/ai/actions`, Undo goes through the trust layer as on a card; a refusal says why.
 */
export function ActivityScreen({
  initial,
  timeZone,
}: {
  initial: AiActionsResponse;
  timeZone: string;
}) {
  return (
    <ActivityLog
      initial={initial}
      timeZone={timeZone}
      now={Date.now()}
      onMore={async (next) => {
        const query = new URLSearchParams({ after: next, limit: String(ACTIVITY_PAGE) });
        const answer = await fetchJson(
          `/v1/ai/actions?${query.toString()}`,
          AiActionsResponseSchema,
        );
        return answer.ok ? answer.data : answer.message;
      }}
      onUndo={async (id) => {
        const answer = await sendJson('POST', `/v1/ai/actions/${id}/undo`, { reason: null });
        if (!answer.ok) {
          const refused = UndoRefusedBodySchema.safeParse(answer.body);
          return refused.success
            ? (UNDO_REFUSAL[refused.data.reason] ?? answer.message)
            : answer.message;
        }
        const result = UndoActionResponseSchema.safeParse(answer.data);
        return result.success ? result.data.action : 'Something went wrong. Nothing was changed.';
      }}
    />
  );
}
