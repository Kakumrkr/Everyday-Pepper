// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import { FeedItemSchema } from '@pepper/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientTextCards, type ClientTextCardsProps, type ClientTextItem } from './client-texts.js';
import { feedLine } from './feed-lines.js';

// Clients' texts on Home (S80, AC-X-232, AC-X-233): the card quotes the text as written, names
// the visit it's likely about, and Reply writes a text with Undo.

afterEach(cleanup);

const NY = 'America/New_York';
const NOW = Date.parse('2026-11-02T15:00:00.000Z');
const CLIENT = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f700011';

const item = (payload: Partial<ClientTextItem['payload']> = {}, names = {}) =>
  FeedItemSchema.parse({
    id: '0199f0a4-7c1e-7d2a-9b3c-4d5e6f700201',
    status: 'suggestion',
    day: '2026-11-02',
    kind: 'client_text',
    payload: {
      textId: '0199f0a4-7c1e-7d2a-9b3c-4d5e6f700301',
      receivedAt: '2026-11-02T14:42:00.000Z',
      count: 1,
      nextVisitStartsAt: '2026-11-05T19:00:00.000Z',
      body: 'Can I bring my daughter <b>Saturday</b>?',
      ...payload,
    },
    subjects: {
      staffMemberId: null,
      clientId: CLIENT,
      bookingId: '0199f0a4-7c1e-7d2a-9b3c-4d5e6f700031',
      serviceId: null,
    },
    names: { staff: 'Jess', client: 'Maria L.', service: 'Haircut', ...names },
    proposalId: null,
    expiresAt: '2026-11-09T14:42:00.000Z',
    createdAt: '2026-11-02T14:42:00.000Z',
  }) as ClientTextItem;

function renderCards(overrides: Partial<ClientTextCardsProps> = {}) {
  const props: ClientTextCardsProps = {
    items: [item()],
    businessName: 'Juniper Hair Studio',
    timeZone: NY,
    now: NOW,
    onReply: vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        replyId: '0199f0a4-7c1e-7d2a-9b3c-4d5e6f700401',
        sendsAt: new Date(Date.now() + 10_000).toISOString(),
      }),
    ),
    onUndo: vi.fn(() => Promise.resolve(null)),
    onDone: vi.fn(() => Promise.resolve(null)),
    renderClientLink: () => <a href={`/clients/${CLIENT}`}>Open Maria L.</a>,
    ...overrides,
  };
  return { props, ...render(<ClientTextCards {...props} />) };
}

describe('feedLine for a client text', () => {
  it('says who texted when, and the visit it is likely about', () => {
    expect(feedLine(item(), NY, NOW)).toEqual({
      title: 'Maria L. texted at 9:42 am',
      why: 'Likely about their next visit: Thu, Nov 5, 2:00 pm for Haircut with Jess.',
    });
    expect(feedLine(item({ count: 3, nextVisitStartsAt: null }), NY, NOW)).toEqual({
      title: 'Maria L. sent 3 texts, the last at 9:42 am',
      why: 'No visit booked. Reply to answer by text.',
    });
  });

  it('never puts the words in its sentences', () => {
    const line = feedLine(item(), NY, NOW);
    expect(`${line.title} ${line.why}`).not.toContain('daughter');
  });
});

describe('ClientTextCards', () => {
  it('shows nothing without texts', () => {
    const { container } = renderCards({ items: [] });
    expect(container.innerHTML).toBe('');
  });

  it('quotes the text as plain text, with Reply, the client and Done', async () => {
    const { container } = renderCards();
    expect(screen.getByRole('heading', { name: 'Texts from clients' })).toBeTruthy();
    const quote = screen.getByTestId('client-text-quote');
    expect(quote.textContent).toBe('Can I bring my daughter <b>Saturday</b>?');
    expect(quote.querySelector('b')).toBeNull();
    expect(screen.getByRole('button', { name: 'Reply' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Maria L.' })).toBeTruthy();
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(result.violations.map((violation) => violation.id)).toEqual([]);
  });

  it('writes a reply, sends it trimmed, and Undo brings the card back', async () => {
    const user = userEvent.setup();
    const { props } = renderCards();
    await user.click(screen.getByRole('button', { name: 'Reply' }));
    const field = screen.getByRole('textbox', { name: 'Your reply to Maria L.' });
    expect(document.activeElement).toBe(field);
    const send = screen.getByRole('button', { name: 'Send reply' });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    await user.type(field, '  Of course, see you then ');
    expect(screen.getByText('274 characters left')).toBeTruthy();
    await user.click(send);
    expect(props.onReply).toHaveBeenCalledWith(props.items[0], 'Of course, see you then');
    expect(screen.getByRole('status').textContent).toContain(
      'Reply to Maria L. goes by text in a few seconds.',
    );
    await user.click(screen.getByRole('button', { name: /Undo/ }));
    expect(props.onUndo).toHaveBeenCalledWith(
      props.items[0],
      '0199f0a4-7c1e-7d2a-9b3c-4d5e6f700401',
    );
    expect(screen.getByRole('button', { name: 'Reply' })).toBeTruthy();
  });

  it('says when a reply waits for the morning', async () => {
    const user = userEvent.setup();
    renderCards({
      onReply: () =>
        Promise.resolve({
          ok: true,
          replyId: '0199f0a4-7c1e-7d2a-9b3c-4d5e6f700401',
          sendsAt: new Date(Date.now() + 10 * 3_600_000).toISOString(),
        }),
    });
    await user.click(screen.getByRole('button', { name: 'Reply' }));
    await user.type(screen.getByRole('textbox'), 'Sure');
    await user.click(screen.getByRole('button', { name: 'Send reply' }));
    expect(screen.getByRole('status').textContent).toMatch(/waits for the morning\. It goes at/);
  });

  it('keeps the words and shows why when a reply is refused', async () => {
    const user = userEvent.setup();
    renderCards({
      onReply: () => Promise.resolve({ ok: false, message: 'This client can’t get texts now.' }),
    });
    await user.click(screen.getByRole('button', { name: 'Reply' }));
    await user.type(screen.getByRole('textbox'), 'Hello');
    await user.click(screen.getByRole('button', { name: 'Send reply' }));
    expect(screen.getByText('This client can’t get texts now.')).toBeTruthy();
    expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('Hello');
  });

  it('Done closes the card; Cancel leaves it as it was', async () => {
    const user = userEvent.setup();
    const { props } = renderCards();
    await user.click(screen.getByRole('button', { name: 'Reply' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(props.onReply).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(props.onDone).toHaveBeenCalled();
    expect(screen.queryByTestId('client-text-card')).toBeNull();
  });
});
