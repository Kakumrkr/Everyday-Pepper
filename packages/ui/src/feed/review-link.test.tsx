// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewLink } from './review-link.js';

afterEach(cleanup);

const LINK = 'https://g.page/r/juniper/review';

describe('ReviewLink (S55.2)', () => {
  it('asks for the link, saying what it is for, and saves it', async () => {
    const onSave = vi.fn(() => Promise.resolve(null));
    const { container } = render(<ReviewLink url={null} addressSet onSave={onSave} />);
    expect(
      screen.getByRole('form', { name: 'Review link for review requests' }).textContent,
    ).toContain('no client is asked more than once in 90 days');
    expect(screen.getByRole('form').textContent).not.toContain('add it above first');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save link' }).disabled).toBe(
      true,
    );
    await userEvent.type(screen.getByLabelText('Your review link'), LINK);
    await userEvent.click(screen.getByRole('button', { name: 'Save link' }));
    expect(onSave).toHaveBeenCalledWith(LINK);
    expect(screen.queryByRole('button', { name: 'Stop asking for reviews' })).toBeNull();
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('says to add the mailing address first when it is missing', () => {
    render(<ReviewLink url={null} addressSet={false} onSave={() => Promise.resolve(null)} />);
    expect(screen.getByRole('form').textContent).toContain('add it above first');
  });

  it('shows the link, changes it, and stops the requests', async () => {
    const onSave = vi.fn<(url: string | null) => Promise<string | null>>(() =>
      Promise.resolve(null),
    );
    render(<ReviewLink url={LINK} addressSet onSave={onSave} />);
    expect(screen.getByTestId('review-link').textContent).toContain(`asks for a review at ${LINK}`);
    await userEvent.click(screen.getByRole('button', { name: 'Change it' }));
    expect(screen.getByLabelText<HTMLInputElement>('Your review link').value).toBe(LINK);
    await userEvent.click(screen.getByRole('button', { name: 'Stop asking for reviews' }));
    expect(onSave).toHaveBeenCalledWith(null);
  });

  it('shows why a save failed and keeps the form', async () => {
    render(
      <ReviewLink url={null} addressSet onSave={() => Promise.resolve('Enter the full address')} />,
    );
    await userEvent.type(screen.getByLabelText('Your review link'), 'g.page');
    await userEvent.click(screen.getByRole('button', { name: 'Save link' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Enter the full address');
    expect(screen.getByLabelText<HTMLInputElement>('Your review link').value).toBe('g.page');
  });
});
