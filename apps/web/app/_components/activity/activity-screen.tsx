'use client';

import { AiActionsResponseSchema, type AiActionsResponse } from '@pepper/contracts';
import { ActivityLog } from '@pepper/ui';
import { ACTIVITY_PAGE } from '../../../lib/activity';
import { fetchJson } from '../../../lib/client-api';
import { undoAction } from '../chat/undo-action';

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
        const result = await undoAction(id);
        return result.ok ? { action: result.action, notice: result.notice } : result.message;
      }}
    />
  );
}
