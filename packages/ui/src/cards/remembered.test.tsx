// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import { MemoryFactShownSchema, type MemoryFactShown } from '@pepper/contracts';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Remembered, type RememberedProps } from './remembered.js';

afterEach(cleanup);

const ALLERGY = '0199f4b2-7c1e-7a00-8000-0000000000f1';
const USUAL = '0199f4b2-7c1e-7a00-8000-0000000000f2';
const GONE = '0199f4b2-7c1e-7a00-8000-0000000000f3';

const facts: MemoryFactShown[] = [
  MemoryFactShownSchema.parse({
    state: 'known',
    factId: ALLERGY,
    subjectType: 'client',
    key: 'allergy',
    value: 'PPD <b>bold</b>',
    previous: null,
    sensitive: true,
  }),
  MemoryFactShownSchema.parse({
    state: 'known',
    factId: USUAL,
    subjectType: 'client',
    key: 'usual_service',
    value: 'Balayage',
    previous: null,
    sensitive: false,
  }),
  MemoryFactShownSchema.parse({ state: 'gone', factId: GONE }),
];

function Harness(props: Partial<RememberedProps>) {
  const [open, setOpen] = useState(false);
  return (
    <Remembered
      count={3}
      facts={facts}
      open={open}
      onToggle={() => {
        setOpen(!open);
      }}
      onFix={() => Promise.resolve(null)}
      onForget={() => Promise.resolve(null)}
      {...props}
    />
  );
}

async function expectAccessible(container: HTMLElement): Promise<void> {
  const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
  expect(result.violations.map((violation) => violation.id)).toEqual([]);
}

describe('Remembered (the chip, S32)', () => {
  it('opens the facts the answer used, as plain text, with gone ones named', async () => {
    const { container } = render(<Harness />);
    const chip = screen.getByRole('button', { name: 'Remembered · 3' });
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    await expectAccessible(container);
    await userEvent.click(chip);
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    const panel = screen.getByRole('region', { name: 'What I remembered for this answer' });
    expect(panel.textContent).toContain('Allergy: PPD <b>bold</b>');
    expect(panel.textContent).toContain('Sensitive');
    expect(panel.textContent).toContain('Usual service: Balayage');
    expect(panel.textContent).toContain('No longer remembered.');
    expect(panel.querySelector('b b')).toBeNull();
    await expectAccessible(container);
  });

  it('fixes a value in place', async () => {
    const onFix = vi.fn(() => Promise.resolve(null));
    render(<Harness onFix={onFix} />);
    await userEvent.click(screen.getByRole('button', { name: /Remembered/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Fix Usual service' }));
    const input = screen.getByLabelText('Usual service');
    await userEvent.clear(input);
    await userEvent.type(input, 'Full color{Enter}');
    expect(onFix).toHaveBeenCalledWith(USUAL, 'Full color');
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'Saved.');
  });

  it('forgets only after a confirm, and says what failed', async () => {
    const onForget = vi
      .fn<(id: string) => Promise<string | null>>()
      .mockResolvedValueOnce('Your role in this business doesn’t allow this.')
      .mockResolvedValueOnce(null);
    const { container } = render(<Harness onForget={onForget} />);
    await userEvent.click(screen.getByRole('button', { name: /Remembered/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Forget Allergy' }));
    expect(onForget).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(onForget).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Forget Allergy' }));
    expect(screen.getByRole('group', { name: 'Forget Allergy?' }).textContent).toContain(
      'can’t be undone',
    );
    await expectAccessible(container);
    await userEvent.click(screen.getByRole('button', { name: 'Forget' }));
    expect(await screen.findByText('Your role in this business doesn’t allow this.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Forget' }));
    expect(onForget).toHaveBeenCalledWith(ALLERGY);
    expect(await screen.findByText('Forgotten. I won’t use it again.')).toBeTruthy();
  });

  it('says when the facts are loading or could not be read', () => {
    const { rerender } = render(
      <Remembered
        count={1}
        facts={null}
        open
        onToggle={vi.fn()}
        onFix={vi.fn()}
        onForget={vi.fn()}
      />,
    );
    expect(screen.getByText('Reading what I remembered…')).toBeTruthy();
    rerender(
      <Remembered
        count={1}
        facts={null}
        error="You seem to be offline."
        open
        onToggle={vi.fn()}
        onFix={vi.fn()}
        onForget={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert').textContent).toBe('You seem to be offline.');
    expect(screen.getByRole('button', { name: 'Remembered' })).toBeTruthy();
  });
});
