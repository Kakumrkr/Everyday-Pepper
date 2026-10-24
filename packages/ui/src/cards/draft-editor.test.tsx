// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MailingAddress } from '../feed/mailing-address.js';
import { DraftEditor } from './draft-editor.js';

afterEach(cleanup);

const draft = { subject: 'Time for a trim?', body: 'Hi Sara,\n\nIt has been a while.' };
const noContrast = { rules: { 'color-contrast': { enabled: false } } };

describe('DraftEditor', () => {
  it('shows the exact words as plain text, without an edit button for someone who can’t decide', async () => {
    const { container } = render(
      <DraftEditor draft={{ ...draft, body: '<b>Hi</b> Sara' }} canEdit={false} onSave={vi.fn()} />,
    );
    expect(screen.getByTestId('nudge-draft').textContent).toContain('<b>Hi</b> Sara');
    expect(container.querySelector('b')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit the words' })).toBeNull();
    expect((await axe.run(container, noContrast)).violations).toEqual([]);
  });

  it('edits and saves the words; the card then shows the new ones', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(() => Promise.resolve(null));
    const { container } = render(<DraftEditor draft={draft} canEdit onSave={onSave} />);
    await user.click(screen.getByRole('button', { name: 'Edit the words' }));
    expect((await axe.run(container, noContrast)).violations).toEqual([]);
    const subject = screen.getByLabelText('Subject');
    await user.clear(subject);
    await user.type(subject, 'See you soon?');
    await user.click(screen.getByRole('button', { name: 'Save the words' }));
    expect(onSave).toHaveBeenCalledWith({ subject: 'See you soon?', body: draft.body });
    expect(screen.queryByRole('form', { name: 'Edit the email' })).toBeNull();
  });

  it('says why when the words are refused, and won’t save over the word limit', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(() => Promise.resolve('Leave out links'));
    render(<DraftEditor draft={draft} canEdit onSave={onSave} />);
    await user.click(screen.getByRole('button', { name: 'Edit the words' }));
    await user.click(screen.getByRole('button', { name: 'Save the words' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Leave out links');
    const message = screen.getByLabelText('Message');
    await user.clear(message);
    await user.click(message);
    await user.paste(Array.from({ length: 121 }, () => 'word').join(' '));
    expect(screen.getByText(/121 of 120 words/)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save the words' }).disabled).toBe(
      true,
    );
  });
});

describe('MailingAddress', () => {
  it('asks for the address when there is none, and saves it', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(() => Promise.resolve(null));
    const { container } = render(<MailingAddress address={null} onSave={onSave} />);
    expect((await axe.run(container, noContrast)).violations).toEqual([]);
    await user.type(screen.getByLabelText('Your business’s mailing address'), '12 Main St');
    await user.click(screen.getByRole('button', { name: 'Save address' }));
    expect(onSave).toHaveBeenCalledWith('12 Main St');
  });

  it('shows the address on one line, and lets it be changed', async () => {
    const user = userEvent.setup();
    render(<MailingAddress address={'12 Main St\nPortland, OR 97201'} onSave={vi.fn()} />);
    expect(screen.getByTestId('mailing-address').textContent).toContain(
      '12 Main St, Portland, OR 97201',
    );
    await user.click(screen.getByRole('button', { name: 'Change it' }));
    expect(screen.getByRole('form', { name: 'Mailing address for rebooking emails' })).toBeTruthy();
  });
});
