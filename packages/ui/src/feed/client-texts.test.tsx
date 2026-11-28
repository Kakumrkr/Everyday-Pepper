// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import { FeedItemSchema } from '@pepper/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ClientTextCards,
  ClientTextReplyBox,
  type ClientTextCardsProps,
  type ClientTextItem,
} from './client-texts.js';
import { clientTextOutcomeLine, feedLine } from './feed-lines.js';

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
    onUndo: vi.fn(() => Promise.resolve('taken_back' as const)),
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

  it('names the day of a text from an earlier day', () => {
    expect(feedLine(item(), NY, NOW + 3 * 86_400_000).title).toBe(
      'Maria L. texted Mon, Nov 2, 9:42 am',
    );
  });

  it('never puts the words in its sentences', () => {
    const line = feedLine(item(), NY, NOW);
    expect(`${line.title} ${line.why}`).not.toContain('daughter');
  });
});

describe('what Pepper did with a text (S81a.2, AC-X-247)', () => {
  const line = (outcome: NonNullable<ClientTextItem['payload']['outcome']>) =>
    clientTextOutcomeLine(item({ outcome }), NY);

  it('says nothing for a text not read', () => {
    expect(clientTextOutcomeLine(item(), NY)).toBeNull();
  });

  it('names the visit it was about once read', () => {
    expect(feedLine(item({ outcome: { kind: 'confirmed' } }), NY, NOW).why).toBe(
      'About their visit Thu, Nov 5, 2:00 pm for Haircut with Jess.',
    );
    // More than one visit fits: still only likely.
    expect(feedLine(item({ outcome: { kind: 'which_visit' } }), NY, NOW).why).toMatch(/^Likely/);
  });

  it('says what was done, and what an OK does', () => {
    expect(line({ kind: 'confirmed' })).toBe('I marked this visit confirmed.');
    expect(line({ kind: 'told_staff', minutesLate: 10 })).toBe(
      'I let Jess know Maria L. is about 10 min late.',
    );
    expect(line({ kind: 'told_staff', minutesLate: null })).toBe(
      'I let Jess know Maria L. is running late.',
    );
    expect(line({ kind: 'cancel_waiting' })).toBe(
      'I lined up the cancel. It waits in Needs your OK, and Maria L. gets an email once you OK it.',
    );
    expect(line({ kind: 'move_waiting', to: '2026-11-05T20:00:00.000Z' as never })).toBe(
      'I lined up a move to Thu, Nov 5, 3:00 pm. It waits in Needs your OK, and Maria L. gets an email once you OK it.',
    );
    expect(line({ kind: 'which_visit' })).toBe(
      'Maria L. has more than one visit booked. Reply to ask which one.',
    );
  });

  it('lists free times with their day once', () => {
    const friday = [
      '2026-11-06T14:00:00.000Z',
      '2026-11-06T14:15:00.000Z',
      '2026-11-06T14:30:00.000Z',
    ];
    expect(line({ kind: 'free_times', times: friday as never })).toBe(
      'Free with Jess: Fri, Nov 6, 9:00 am, 9:15 am or 9:30 am. Reply to offer one.',
    );
    const twoDays = ['2026-11-06T14:00:00.000Z', '2026-11-09T14:00:00.000Z'];
    expect(line({ kind: 'free_times', times: twoDays as never })).toBe(
      'Free with Jess: Fri, Nov 6, 9:00 am or Mon, Nov 9, 9:00 am. Reply to offer one.',
    );
  });

  it('shows the line on the card under the quote', () => {
    renderCards({ items: [item({ outcome: { kind: 'confirmed' } })] });
    expect(screen.getByTestId('client-text-outcome').textContent).toBe(
      'I marked this visit confirmed.',
    );
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

  it('says a reply went when Undo is too late, and offers Undo no more', async () => {
    const user = userEvent.setup();
    renderCards({ onUndo: () => Promise.resolve('too_late') });
    await user.click(screen.getByRole('button', { name: 'Reply' }));
    await user.type(screen.getByRole('textbox'), 'Hi');
    await user.click(screen.getByRole('button', { name: 'Send reply' }));
    await user.click(screen.getByRole('button', { name: /Undo/ }));
    expect(screen.getByRole('status').textContent).toContain('Reply to Maria L. sent by text.');
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
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

describe('ClientTextReplyBox', () => {
  it('replies from the profile and Undo brings the button back', async () => {
    const user = userEvent.setup();
    const onReply = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        replyId: '0199f0a4-7c1e-7d2a-9b3c-4d5e6f700401',
        sendsAt: new Date(Date.now() + 10_000).toISOString(),
      }),
    );
    render(
      <ClientTextReplyBox
        clientName="Maria L."
        businessName="Juniper Hair Studio"
        timeZone={NY}
        onReply={onReply}
        onUndo={() => Promise.resolve('taken_back')}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Reply by text' }));
    await user.type(screen.getByRole('textbox', { name: 'Your reply to Maria L.' }), 'See you');
    await user.click(screen.getByRole('button', { name: 'Send reply' }));
    expect(onReply).toHaveBeenCalledWith('See you');
    await user.click(screen.getByRole('button', { name: /Undo/ }));
    expect(screen.getByRole('button', { name: 'Reply by text' })).toBeTruthy();
  });
});
