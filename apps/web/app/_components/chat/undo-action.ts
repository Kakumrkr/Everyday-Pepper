import {
  UndoActionResponseSchema,
  UndoRefusedBodySchema,
  type AiActionView,
} from '@pepper/contracts';
import { sendJson } from '../../../lib/client-api';

// Undo through the trust layer (S26, ADR-0031), shared by a card and the Activity log (S52):
// the receipt as it is now and what happened to its emails, or why it was refused, in words.

const UNDO_REFUSAL: Record<string, string> = {
  slot_taken: 'That time has been booked since, so I can’t put it back. Nothing was changed.',
  already_started: 'The appointment has started, so it can’t be undone. Nothing was changed.',
  already_sent: 'The email has already left, so it can’t be unsent. Nothing was changed.',
  changed_since: 'It was changed since, so undoing it would lose that. Nothing was changed.',
  not_possible: 'This can’t be undone any more. Nothing was changed.',
};

export type UndoResult =
  { ok: true; action: AiActionView; notice: string } | { ok: false; message: string };

/** Undoes the receipt `id`, with no reason given. */
export async function undoAction(id: string): Promise<UndoResult> {
  const answer = await sendJson('POST', `/v1/ai/actions/${id}/undo`, { reason: null });
  if (!answer.ok) {
    const refused = UndoRefusedBodySchema.safeParse(answer.body);
    return {
      ok: false,
      message: refused.success
        ? (UNDO_REFUSAL[refused.data.reason] ?? answer.message)
        : answer.message,
    };
  }
  const result = UndoActionResponseSchema.safeParse(answer.data);
  if (!result.success) return { ok: false, message: 'Something went wrong.' };
  return {
    ok: true,
    action: result.data.action,
    notice:
      result.data.alreadySent > 0
        ? 'Undone. The client was already emailed, and I didn’t email them again.'
        : result.data.takenBack > 0
          ? 'Undone, and the email was taken back before it left.'
          : 'Undone.',
  };
}
