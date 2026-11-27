'use client';

import { ClientTextReplySchema, ClientTextUndoSchema, type FeedResponse } from '@pepper/contracts';
import { buttonStyle, ClientTextCards, type ClientTextItem } from '@pepper/ui';
import Link from 'next/link';
import { ROUTES } from '../../../lib/account';
import { sendJson } from '../../../lib/client-api';

/** The feed's client texts (S80): shown on their own cards, never on the suggestion board. */
export function clientTextItems(feed: FeedResponse): ClientTextItem[] {
  return feed.suggestions.filter(
    (item): item is (typeof feed.suggestions)[number] & ClientTextItem =>
      item.kind === 'client_text',
  );
}

/**
 * Home's "Texts from clients" (S80, ADR-0072, AC-X-232, AC-X-233) on `/v1/feed`: Reply queues a
 * text (`POST /v1/clients/:id/texts/replies`, closing the card), Undo takes it back while it
 * waits, Done closes the card.
 */
export function ClientTextsCard({
  feed,
  businessName,
  timeZone,
}: {
  feed: FeedResponse;
  businessName: string;
  timeZone: string;
}) {
  return (
    <ClientTextCards
      items={clientTextItems(feed)}
      businessName={businessName}
      timeZone={timeZone}
      now={Date.now()}
      onReply={async (item, body) => {
        const clientId = item.subjects.clientId;
        if (clientId === null) return { ok: false, message: 'This client is gone.' };
        const answer = await sendJson('POST', `/v1/clients/${clientId}/texts/replies`, {
          body,
          feedItemId: item.id,
        });
        if (!answer.ok) return { ok: false, message: answer.message };
        const reply = ClientTextReplySchema.parse(answer.data);
        return { ok: true, replyId: reply.replyId, sendsAt: reply.sendsAt };
      }}
      onUndo={async (item, replyId) => {
        const clientId = item.subjects.clientId;
        if (clientId === null) return 'This client is gone.';
        const answer = await sendJson(
          'DELETE',
          `/v1/clients/${clientId}/texts/replies/${replyId}`,
          undefined,
        );
        if (!answer.ok) return answer.message;
        return ClientTextUndoSchema.parse(answer.data).outcome === 'taken_back'
          ? null
          : 'Too late: the reply was already sent.';
      }}
      onDone={async (item) => {
        const answer = await sendJson('POST', `/v1/feed/${item.id}/close`, { outcome: 'done' });
        return answer.ok ? null : answer.message;
      }}
      renderClientLink={(item) =>
        item.subjects.clientId === null ? null : (
          <Link
            href={`${ROUTES.clients}/${item.subjects.clientId}`}
            className={buttonStyle({ variant: 'secondary', size: 'sm' })}
          >
            {`Open ${item.names.client ?? 'the client'}`}
          </Link>
        )
      }
    />
  );
}
