// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button, IconButton, buttonStyle } from './button.js';
import { Checkbox, Input, Select, Switch, Textarea } from './fields.js';
import { Avatar, Badge, MoneyChip, Skeleton, formatMoney, initialsOf } from './marks.js';

afterEach(cleanup);

/** axe on the rendered part (jsdom has no layout, so contrast is checked on the tokens). */
async function expectAccessible(container: HTMLElement): Promise<void> {
  const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
  expect(result.violations.map((violation) => violation.id)).toEqual([]);
}

describe('Button', () => {
  it('is a pill in the brand color by default, and runs its action from the keyboard', async () => {
    const onClick = vi.fn();
    const { container } = render(<Button onClick={onClick}>Approve</Button>);
    const button = screen.getByRole('button', { name: 'Approve' });
    expect(button).toHaveProperty('type', 'button');
    expect(button.className).toContain('bg-brand');
    expect(button.className).toContain('rounded-pill');
    button.focus();
    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledOnce();
    await expectAccessible(container);
  });

  it('says it is busy and cannot be pressed twice', async () => {
    const onClick = vi.fn();
    render(
      <Button busy onClick={onClick}>
        Saving
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Saving' });
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button).toHaveProperty('disabled', true);
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it.each([
    ['secondary', 'border-line-strong'],
    ['quiet', 'text-brand'],
    ['danger', 'text-danger'],
  ] as const)('has a %s variant', (variant, token) => {
    expect(buttonStyle({ variant })).toContain(token);
  });

  it('keeps the 44 px tap target at every size, and grows primary actions to 48 and 54 px', () => {
    expect(buttonStyle({ size: 'sm' })).toContain('min-h-11');
    expect(buttonStyle({ size: 'md' })).toContain('min-h-12');
    expect(buttonStyle({ size: 'lg' })).toContain('min-h-13.5');
    expect(buttonStyle({ block: true })).toContain('w-full');
  });
});

describe('IconButton', () => {
  it('is named by its label and 44 px square', async () => {
    const { container } = render(<IconButton icon="close" label="Close" />);
    const button = screen.getByRole('button', { name: 'Close' });
    expect(button.className).toContain('size-11');
    await expectAccessible(container);
  });
});

describe('fields', () => {
  it('ties the label, hint and error to the input', async () => {
    const { container } = render(
      <Input label="Phone" hint="We text reminders here" error="That number is too short." />,
    );
    const input = screen.getByLabelText('Phone');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const described = (input.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(['We text reminders here', 'That number is too short.']);
    await expectAccessible(container);
  });

  it('leaves a field without hint or error undescribed and valid', () => {
    render(<Input label="Name" />);
    const input = screen.getByLabelText('Name');
    expect(input.hasAttribute('aria-describedby')).toBe(false);
    expect(input.hasAttribute('aria-invalid')).toBe(false);
  });

  it('takes typing in a textarea', async () => {
    const { container } = render(<Textarea label="Note" />);
    await userEvent.type(screen.getByLabelText('Note'), 'Short beard');
    expect(screen.getByLabelText('Note')).toHaveProperty('value', 'Short beard');
    await expectAccessible(container);
  });

  it('offers its options in a native select', async () => {
    const { container } = render(
      <Select
        label="Barber"
        defaultValue="dre"
        options={[
          { value: 'dre', label: 'Dre' },
          { value: 'randy', label: 'Randy' },
        ]}
      />,
    );
    const select = screen.getByLabelText('Barber');
    await userEvent.selectOptions(select, 'randy');
    expect(select).toHaveProperty('value', 'randy');
    await expectAccessible(container);
  });

  it('toggles a checkbox by its label', async () => {
    const { container } = render(<Checkbox label="Text me too" hint="One text per booking" />);
    await userEvent.click(screen.getByText('Text me too'));
    expect(screen.getByRole('checkbox', { name: 'Text me too' })).toHaveProperty('checked', true);
    await expectAccessible(container);
  });

  it("makes the checkbox's whole row its tap target, the hint kept out of its name (D3)", () => {
    render(<Checkbox label="Haircut" hint="Not bookable yet" />);
    const box = screen.getByRole('checkbox', { name: 'Haircut' });
    const label = box.closest('label');
    expect(label?.className).toContain('min-h-11');
    expect(label?.textContent).toBe('Haircut');
    expect(box.getAttribute('aria-describedby')).toBeTruthy();
  });

  it("makes the switch's row its tap target, the hint below and out of its name (D3)", async () => {
    render(<Switch label="Ask me first" hint="I wait for an OK" />);
    const toggle = screen.getByRole('switch', { name: 'Ask me first' });
    const row = toggle.closest('label');
    expect(row?.className).toContain('min-h-11');
    expect(row?.textContent).toBe('Ask me first');
    expect(toggle.getAttribute('aria-describedby')).toBeTruthy();
    // Tapping the label, away from the switch itself, toggles it; reading the hint doesn't.
    await userEvent.click(screen.getByText('Ask me first'));
    expect(toggle).toHaveProperty('checked', true);
    await userEvent.click(screen.getByText('I wait for an OK'));
    expect(toggle).toHaveProperty('checked', true);
  });

  it('is a switch to screen readers, toggled with Space', async () => {
    const onChange = vi.fn();
    const { container } = render(
      <Switch label="Pause suggestions" hint="Pepper stops proposing" onChange={onChange} />,
    );
    const toggle = screen.getByRole('switch', { name: 'Pause suggestions' });
    toggle.focus();
    await userEvent.keyboard(' ');
    expect(toggle).toHaveProperty('checked', true);
    expect(onChange).toHaveBeenCalledOnce();
    await expectAccessible(container);
  });
});

describe('marks', () => {
  it('formats money from cents, dropping .00', () => {
    expect(formatMoney(4500)).toBe('$45');
    expect(formatMoney(108000)).toBe('$1,080');
    expect(formatMoney(4550)).toBe('$45.50');
    expect(formatMoney(0)).toBe('$0');
    expect(() => formatMoney(45.5)).toThrow(RangeError);
  });

  it.each([
    ['gain', '+$45', 'adds $45'],
    ['estimate', '~$45', 'about $45'],
    ['amount', '$45', '$45'],
  ] as const)('shows a %s chip in tabular figures, and says it in words', (kind, shown, spoken) => {
    const { container } = render(<MoneyChip cents={4500} kind={kind} />);
    const chip = container.firstElementChild;
    expect(chip?.className).toContain('tabular-nums');
    expect(chip?.className).toContain('bg-accent');
    expect(chip?.querySelector('[aria-hidden]')?.textContent).toBe(shown);
    expect(chip?.querySelector('.sr-only')?.textContent).toBe(spoken);
  });

  it('takes initials from a name', () => {
    expect(initialsOf('Marcus Bell')).toBe('MB');
    expect(initialsOf("  Mike  O'Connor ")).toBe('MO');
    expect(initialsOf('Dre')).toBe('D');
    expect(initialsOf('Dre Carter Jr')).toBe('DJ');
    expect(initialsOf('')).toBe('');
  });

  it('hides decorative avatars and skeletons from screen readers', async () => {
    const { container } = render(
      <div>
        <Avatar name="Marcus Bell" />
        <Avatar name="Randy" tone="accent" size="lg" />
        <Skeleton />
        <Badge tone="warn">Overdue</Badge>
      </div>,
    );
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(3);
    expect(screen.getByText('Overdue').className).toContain('text-warn');
    await expectAccessible(container);
  });
});
