// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import {
  BookingViewSchema,
  LocalSlotSchema,
  MemoryFactIdSchema,
  MemoryFactShownSchema,
} from '@pepper/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChangeCard, type ChangeCardProps } from './change-card.js';
import { BookingCard, ClientChoice, DayCard, PlanCard, SlotPicker } from './choices.js';
import { whyModel } from './labels.js';
import { ChatNotice, FallbackNotice, WhyContent } from './why.js';

afterEach(cleanup);

const TZ = 'America/New_York';
const NOW = Date.parse('2026-10-27T14:00:00.000Z');
const CLIENT = '0199f4b2-7c1e-7a00-8000-0000000000c1';
const STAFF = '0199f4b2-7c1e-7a00-8000-0000000000d1';
const SERVICE = '0199f4b2-7c1e-7a00-8000-0000000000e1';
const BOOKING = '0199f4b2-7c1e-7a00-8000-0000000000b1';

const side = {
  clientId: CLIENT,
  clientName: 'Maria L.',
  serviceName: 'Haircut',
  staffName: 'Jess',
  date: '2026-10-27',
  time: '17:15',
  endTime: '18:15',
};

function change(overrides: Partial<ChangeCardProps> = {}): ChangeCardProps {
  return {
    action: 'booking.create',
    status: 'proposed',
    summary: 'New booking: Maria L., Haircut with Jess, Tue 2026-10-27 at 17:15.',
    before: null,
    after: side,
    emails: [{ template: 'confirmed', clientId: CLIENT }],
    undoUntil: null,
    canDecide: true,
    canUndo: false,
    timeZone: TZ,
    now: NOW,
    ...overrides,
  };
}

/** axe on the rendered card (jsdom has no layout, so contrast is checked on the tokens). */
async function expectAccessible(container: HTMLElement): Promise<void> {
  const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
  expect(result.violations.map((violation) => violation.id)).toEqual([]);
}

describe('ChangeCard', () => {
  it('shows exactly the change and the email, and Approve/Not now from the keyboard', async () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const { container } = render(
      <ChangeCard {...change({ onApprove, onReject, onWhy: vi.fn() })} />,
    );
    const card = screen.getByRole('article', { name: 'New booking' });
    expect(within(card).getByText('Needs your OK')).toBeTruthy();
    expect(within(card).getByText('Tue, Oct 27 · 5:15 pm–6:15 pm')).toBeTruthy();
    expect(within(card).getByText('Emails Maria L. a confirmation.')).toBeTruthy();
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(within(card).getByRole('button', { name: 'Approve' }));
    await user.keyboard('{Enter}');
    expect(onApprove).toHaveBeenCalledTimes(1);
    await user.tab();
    await user.keyboard(' ');
    expect(onReject).toHaveBeenCalledTimes(1);
    await expectAccessible(container);
  });

  it('never takes focus by itself (no focus theft while streaming)', () => {
    render(<ChangeCard {...change()} />);
    expect(document.activeElement).toBe(document.body);
  });

  it('offers no Approve to someone who may not decide, nor on a settled proposal', () => {
    render(<ChangeCard {...change({ canDecide: false })} />);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    cleanup();
    for (const status of ['expired', 'rejected', 'superseded', 'refused'] as const) {
      render(<ChangeCard {...change({ status })} />);
      expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
      cleanup();
    }
  });

  it('a receipt shows Undo with its window, the email waiting, and who approved it', async () => {
    const onUndo = vi.fn();
    const { container } = render(
      <ChangeCard
        {...change({
          status: 'done',
          canDecide: false,
          canUndo: true,
          undoUntil: '2026-10-28T14:00:00.000Z',
          approvedByName: 'Ana',
          emails: [
            {
              template: 'confirmed',
              clientId: CLIENT,
              status: 'waiting',
              sendsAt: '2026-10-27T14:02:00.000Z',
            },
          ],
          onUndo,
        })}
      />,
    );
    expect(screen.getByText('You can undo this until Wed, Oct 28, 10:00 am.')).toBeTruthy();
    expect(
      screen.getByText('The confirmation to Maria L. goes at 10:02 am, unless you undo.'),
    ).toBeTruthy();
    expect(screen.getByText('Approved by Ana.')).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalledTimes(1);
    await expectAccessible(container);
  });

  it('no Undo once the window closed; "already emailed" after the email left', () => {
    render(
      <ChangeCard
        {...change({
          status: 'done',
          canUndo: true,
          undoUntil: '2026-10-27T13:00:00.000Z',
          emails: [{ template: 'confirmed', clientId: CLIENT, status: 'sent', sendsAt: null }],
        })}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(screen.getByText('Maria L. was already emailed a confirmation.')).toBeTruthy();
  });

  it('announces the outcome of a tap politely, in a status region', () => {
    render(
      <ChangeCard
        {...change({ status: 'undone', notice: 'Undone. Maria L. was already emailed.' })}
      />,
    );
    expect(screen.getByRole('status').textContent).toBe('Undone. Maria L. was already emailed.');
  });

  it('renders text as text: markup in a summary is never HTML (OWASP LLM10)', () => {
    const { container } = render(
      <ChangeCard
        {...change({
          summary: '<img src=x onerror="alert(1)"><a href="https://evil.test">click</a>',
          after: { ...side, clientName: '<b>Maria</b>' },
        })}
      />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByText(/<img src=x/)).toBeTruthy();
  });

  it('a move shows the old time struck through and says it changes', () => {
    render(
      <ChangeCard
        {...change({
          action: 'booking.move',
          before: { ...side, time: '10:00', endTime: '11:00' },
          emails: [],
        })}
      />,
    );
    const when = screen.getByText('Tue, Oct 27 · 10:00 am–11:00 am');
    expect(when.tagName).toBe('S');
    expect(screen.getByText('changes to', { exact: false })).toBeTruthy();
    expect(screen.getByText('No email to the client.')).toBeTruthy();
  });
});

describe('ChangeCard with memory (S30)', () => {
  const known = (key: string, value: string, previous: string | null = null) =>
    MemoryFactShownSchema.parse({
      state: 'known',
      factId: `0199f4b2-7c1e-7a00-8000-0000000000${key.length > 5 ? 'f1' : 'f2'}`,
      subjectType: 'client',
      key,
      value,
      previous,
      sensitive: key === 'allergy',
    });

  it('a booking warns about an allergy and shows the last visit, as plain text (AC-W3-2)', async () => {
    const { container } = render(
      <ChangeCard
        {...change({
          memory: {
            fact: null,
            warnings: [known('allergy', 'PPD <script>x</script>')],
            lastVisit: {
              date: '2026-10-13',
              serviceName: 'Colour',
              notes: [known('formula', '6N + 20 vol, 35 min')],
            },
          },
        })}
      />,
    );
    const note = screen.getByRole('note');
    expect(within(note).getByText('Heads up')).toBeTruthy();
    expect(within(note).getByText('Allergy: PPD <script>x</script>')).toBeTruthy();
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText('Last time (Tue, Oct 13, Colour):')).toBeTruthy();
    expect(screen.getByText('Formula: 6N + 20 vol, 35 min')).toBeTruthy();
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('a saved fact shows its value and the one it replaced; a forgotten one says so', () => {
    const saved = render(
      <ChangeCard
        {...change({
          action: 'client_note.save',
          status: 'done',
          summary: "Update Maria L.'s usual service (the old one can be brought back with Undo).",
          after: { factId: 'f1', about: 'Maria L.', key: 'usual_service', sensitive: false },
          emails: [],
          memory: {
            fact: known('usual_service', 'Colour with Jess', 'Haircut with Marco'),
            warnings: [],
            lastVisit: null,
          },
        })}
      />,
    );
    expect(screen.getByText('Colour with Jess')).toBeTruthy();
    expect(screen.getByText('(was: Haircut with Marco)', { exact: false })).toBeTruthy();
    expect(screen.getByText('Maria L.')).toBeTruthy();
    expect(screen.queryByText('No email to the client.')).toBeNull();
    saved.unmount();
    render(
      <ChangeCard
        {...change({
          action: 'client_note.save',
          status: 'done',
          summary: "Forget Maria L.'s allergy everywhere, for good.",
          after: { factId: 'f1', about: 'Maria L.', key: 'allergy', forgotten: true },
          emails: [],
          memory: {
            fact: {
              state: 'gone',
              factId: MemoryFactIdSchema.parse('0199f4b2-7c1e-7a00-8000-0000000000f1'),
            },
            warnings: [],
            lastVisit: null,
          },
        })}
      />,
    );
    expect(screen.getByText('A fact you deleted')).toBeTruthy();
    expect(screen.getByText('Everywhere, for good')).toBeTruthy();
  });
});

describe('SlotPicker and ClientChoice', () => {
  const slots = [
    { date: '2026-10-27', time: '12:30', staffMemberId: STAFF, staffName: 'Jess' },
    { date: '2026-10-27', time: '17:15', staffMemberId: STAFF, staffName: 'Jess' },
  ].map((slot) => LocalSlotSchema.parse(slot));

  it('the member picks a time with the keyboard; then the choice stays marked', async () => {
    const onPick = vi.fn();
    const { container, rerender } = render(<SlotPicker slots={slots} onPick={onPick} />);
    const group = screen.getByRole('group', { name: 'Pick a time' });
    const user = userEvent.setup();
    await user.tab();
    await user.tab();
    await user.keyboard('{Enter}');
    expect(onPick).toHaveBeenCalledWith(slots[1]);
    rerender(<SlotPicker slots={slots} onPick={onPick} picked={slots[1] ?? null} />);
    const chosen = within(group).getByRole('button', { name: /5:15 pm/ });
    expect(chosen.getAttribute('aria-pressed')).toBe('true');
    expect((chosen as HTMLButtonElement).disabled).toBe(true);
    await expectAccessible(container);
  });

  it('asks which client, never guessing', async () => {
    const onPick = vi.fn();
    const clients = [
      { clientId: CLIENT, name: 'Sarah K.' },
      { clientId: BOOKING, name: 'Sarah M.' },
    ];
    const { container } = render(<ClientChoice clients={clients} onPick={onPick} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sarah M.' }));
    expect(onPick).toHaveBeenCalledWith(clients[1]);
    await expectAccessible(container);
  });
});

describe('BookingCard, DayCard and PlanCard', () => {
  const booking = BookingViewSchema.parse({
    bookingId: BOOKING,
    date: '2026-10-27',
    time: '10:00',
    endTime: '11:00',
    clientId: CLIENT,
    clientName: 'Maria L.',
    serviceId: SERVICE,
    serviceName: 'Haircut',
    staffMemberId: STAFF,
    staffName: 'Jess',
    status: 'confirmed',
  });

  it('show a booking and a day in time order', async () => {
    const { container } = render(
      <>
        <BookingCard booking={booking} />
        <DayCard
          day={{
            kind: 'day',
            date: '2026-10-27',
            bookings: [booking],
            blocked: [
              {
                staffMemberId: booking.staffMemberId,
                staffName: 'Jess',
                from: '09:00',
                to: '09:30',
              },
            ],
          }}
        />
      </>,
    );
    expect(screen.getByText('Tue, Oct 27 · 10:00 am–11:00 am')).toBeTruthy();
    const items = within(screen.getByRole('region', { name: 'Tue, Oct 27' })).getAllByRole(
      'listitem',
    );
    expect(items.map((item) => item.textContent)).toEqual([
      '9:00 amJess: blocked until 9:30 am',
      '10:00 amMaria L. · Haircut · Jess',
    ]);
    await expectAccessible(container);
  });

  it('a plan approves all its pending changes with one button, only when there are several', async () => {
    const onApproveAll = vi.fn();
    const { rerender } = render(
      <PlanCard pending={2} onApproveAll={onApproveAll}>
        <p>changes</p>
      </PlanCard>,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Approve all 2' }));
    expect(onApproveAll).toHaveBeenCalledTimes(1);
    rerender(
      <PlanCard pending={1} onApproveAll={onApproveAll}>
        <p>changes</p>
      </PlanCard>,
    );
    expect(screen.queryByRole('button', { name: /Approve all/ })).toBeNull();
  });
});

describe('WhyContent and the chat notices', () => {
  it('lists the remembered facts it used (S30)', () => {
    render(
      <WhyContent
        why={{
          ...whyModel(
            {
              asked: { kind: 'none' },
              steps: [],
              decision: { outcome: 'propose', reason: 'setting' },
              untrustedContext: true,
            },
            'booking.create',
            0,
          ),
          remembered: ['Allergy: PPD', 'A fact you deleted'],
        }}
      />,
    );
    expect(screen.getByText('What I remembered')).toBeTruthy();
    expect(screen.getByText('A fact you deleted')).toBeTruthy();
  });

  it('lists what was checked when the record has facts (S26b)', async () => {
    const why = whyModel(
      {
        asked: { kind: 'none' },
        steps: [{ tool: 'unblock_time' }],
        decision: { outcome: 'execute_and_notify', reason: 'setting' },
        untrustedContext: false,
        facts: [{ kind: 'bookings_untouched', value: null }],
      },
      'time.block',
      0,
    );
    const { container } = render(<WhyContent why={why} />);
    expect(screen.getByRole('heading', { name: 'What I checked' })).toBeTruthy();
    expect(screen.getByText('Bookings stay as they are; I only removed the block.')).toBeTruthy();
    await expectAccessible(container);
  });

  it('shows the record’s parts and a link to the setting', async () => {
    const why = whyModel(
      {
        asked: { kind: 'message', text: '<script>alert(1)</script> book Maria' },
        steps: [{ tool: 'create_booking' }],
        decision: { outcome: 'propose', reason: 'setting' },
        untrustedContext: false,
      },
      'booking.create',
      1,
    );
    const { container } = render(
      <WhyContent why={why} autonomyLink={{ label: 'Change it in Autonomy', href: '/autonomy' }} />,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText('Create a booking: Ask me')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Change it in Autonomy' }).getAttribute('href')).toBe(
      '/autonomy',
    );
    await expectAccessible(container);
  });

  it('shows a fallback’s link only when it is a path in this app', () => {
    render(
      <FallbackNotice
        fallback={{
          reason: 'provider_unavailable',
          text: 'I can’t reach my AI right now.',
          link: { label: 'Calendar', href: '/calendar' },
        }}
      />,
    );
    expect(screen.getByRole('link', { name: 'Calendar' }).getAttribute('href')).toBe('/calendar');
    cleanup();
    render(<ChatNotice text="Off." link={{ label: 'Go', href: '//evil.test' }} />);
    expect(screen.queryByRole('link')).toBeNull();
    cleanup();
    render(<ChatNotice text="Off." link={{ label: 'Go', href: 'javascript:alert(1)' }} />);
    expect(screen.queryByRole('link')).toBeNull();
  });
});
