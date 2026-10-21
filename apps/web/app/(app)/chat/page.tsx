import {
  ChatHistoryResponseSchema,
  ChatStatusSchema,
  ConversationsResponseSchema,
} from '@pepper/contracts';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ROUTES } from '../../../lib/account';
import { emptyChat, itemsOfHistory, type ChatState } from '../../../lib/chat-state';
import { ChatScreen } from '../../_components/chat/chat-screen';
import { currentAccount, currentBusiness, currentJson } from '../../_server/account';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Chat · Pepper' };

/**
 * Chat with Pepper (S26, ADR-0031). Opens on the member's latest conversation (Microsoft HAX
 * G12: remember recent interactions); conversations are their own. With the AI off or paused,
 * the chat says so with a link, and every other screen works (AC-X-2).
 */
export default async function ChatPage() {
  // The app layout has sent anyone without a usable session elsewhere already.
  const account = await currentAccount();
  if (account.state !== 'signed-in') return null;
  const current = await currentBusiness();
  if (!current?.permissions.includes('ai.chat')) redirect(ROUTES.home);

  const [status, conversations] = await Promise.all([
    currentJson('/v1/chat/status', ChatStatusSchema),
    currentJson('/v1/chat/conversations', ConversationsResponseSchema),
  ]);
  const latest = conversations?.conversations[0];
  const history =
    latest === undefined
      ? null
      : await currentJson(`/v1/chat/conversations/${latest.id}`, ChatHistoryResponseSchema);
  const initial: ChatState =
    history === null
      ? emptyChat
      : {
          ...emptyChat,
          conversationId: history.conversationId,
          items: itemsOfHistory(history.items),
        };
  return (
    <ChatScreen
      // The api not answering reads as the AI being unavailable; the rest of the app still works.
      status={status?.state ?? 'off'}
      initial={initial}
      timeZone={current.business.timeZone}
      lead={current.role !== 'staff'}
    />
  );
}
