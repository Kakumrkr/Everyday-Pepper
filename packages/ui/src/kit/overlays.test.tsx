// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button } from './button.js';
import { Dialog, Segmented, Sheet, SheetFooter, Tabs, Toast, ToastProvider } from './overlays.js';

afterEach(cleanup);

// jsdom has no pointer capture, which Radix's pointer handlers call.
Object.assign(Element.prototype, {
  hasPointerCapture: () => false,
  releasePointerCapture: () => undefined,
});

async function expectAccessible(container: Element): Promise<void> {
  const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
  expect(result.violations.map((violation) => violation.id)).toEqual([]);
}

function SheetDemo({ kind }: { kind: 'sheet' | 'dialog' }) {
  const [open, setOpen] = useState(false);
  const Overlay = kind === 'sheet' ? Sheet : Dialog;
  return (
    <Overlay
      open={open}
      onOpenChange={setOpen}
      title="Move Darius Hill to 4:15?"
      description="He asked for anything after 4."
      trigger={<Button>Review</Button>}
      footer={
        <Button
          onClick={() => {
            setOpen(false);
          }}
        >
          Approve
        </Button>
      }
    >
      <p>Keeps a $35 visit.</p>
    </Overlay>
  );
}

describe.each(['sheet', 'dialog'] as const)('%s', (kind) => {
  it('opens as a named modal dialog, keeps focus inside, and Escape returns focus', async () => {
    render(<SheetDemo kind={kind} />);
    const trigger = screen.getByRole('button', { name: 'Review' });
    await userEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Move Darius Hill to 4:15?' });
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await expectAccessible(dialog);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(document.activeElement).toBe(trigger);
  });

  it('closes from its Close button', async () => {
    render(<SheetDemo kind={kind} />);
    await userEvent.click(screen.getByRole('button', { name: 'Review' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });
});

describe('Sheet without a trigger', () => {
  it('returns focus to `returnFocus` on close, not just the last focused element (S41)', async () => {
    function Opened() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button
            onClick={() => {
              setOpen(true);
            }}
          >
            Why?
          </Button>
          <Button>Undo</Button>
          <Sheet
            open={open}
            onOpenChange={setOpen}
            title="Why I did this"
            returnFocus={() => screen.getByRole('button', { name: 'Undo' })}
          >
            <p>Your settings let me book on my own.</p>
          </Sheet>
        </>
      );
    }
    render(<Opened />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Why?' }));
    expect(screen.getByRole('dialog', { name: 'Why I did this' })).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Undo' }));
  });
});

describe('SheetFooter', () => {
  it("puts a form's actions in the sheet's footer, below the scrolling body (D3, S42.2)", async () => {
    function Form() {
      const [saved, setSaved] = useState(false);
      return (
        <form
          id="service"
          onSubmit={(event) => {
            event.preventDefault();
            setSaved(true);
          }}
        >
          <p>{saved ? 'Saved' : 'Line-up, 20 min'}</p>
          <SheetFooter>
            <Button type="submit" form="service">
              Save
            </Button>
          </SheetFooter>
        </form>
      );
    }
    render(
      <Sheet open onOpenChange={() => undefined} title="Edit Line-up">
        <Form />
      </Sheet>,
    );
    const save = await screen.findByRole('button', { name: 'Save' });
    const footer = save.parentElement;
    expect(footer?.dataset['slot']).toBe('sheet-footer');
    // Not inside the body that scrolls, and after it, so it stays at the bottom.
    const body = screen.getByText('Line-up, 20 min').closest('[data-slot="sheet-body"]');
    expect(body?.contains(save)).toBe(false);
    expect(body?.nextElementSibling).toBe(footer);
    await userEvent.click(save);
    expect(screen.getByText('Saved')).toBeTruthy();
    await expectAccessible(screen.getByRole('dialog'));
  });

  it('leaves the actions in place outside a sheet (the same form on a page)', () => {
    render(
      <form id="details">
        <SheetFooter>
          <Button type="submit">Save details</Button>
        </SheetFooter>
      </form>,
    );
    expect(screen.getByRole('button', { name: 'Save details' }).closest('form')?.id).toBe(
      'details',
    );
  });

  it('leaves no empty footer when nothing is put in it', () => {
    render(
      <Sheet open onOpenChange={() => undefined} title="Why I did this">
        <p>Your settings let me book on my own.</p>
      </Sheet>,
    );
    expect(document.querySelector('[data-slot="sheet-footer"]')?.className).toContain(
      'empty:hidden',
    );
  });
});

describe('Tabs', () => {
  it('shows one panel and moves along with the arrow keys', async () => {
    const { container } = render(
      <Tabs
        label="Marcus Bell"
        tabs={[
          { value: 'visits', label: 'Visits', content: <p>Sep 22 Skin fade + beard</p> },
          { value: 'memory', label: 'What I know', content: <p>Short beard</p> },
        ]}
      />,
    );
    expect(screen.getByRole('tabpanel').textContent).toBe('Sep 22 Skin fade + beard');
    screen.getByRole('tab', { name: 'Visits' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'What I know' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByRole('tabpanel').textContent).toBe('Short beard');
    await expectAccessible(container);
  });
});

describe('Segmented', () => {
  function Demo({ onChange }: { onChange: (value: string) => void }) {
    const [value, setValue] = useState('both');
    return (
      <Segmented
        label="Whose calendar"
        value={value}
        onValueChange={(next) => {
          setValue(next);
          onChange(next);
        }}
        options={[
          { value: 'both', label: 'Both' },
          { value: 'dre', label: 'Dre' },
          { value: 'randy', label: 'Randy' },
        ]}
      />
    );
  }

  it('is a radio group with exactly one option chosen', async () => {
    const onChange = vi.fn();
    const { container } = render(<Demo onChange={onChange} />);
    const group = screen.getByRole('radiogroup', { name: 'Whose calendar' });
    const dre = screen.getByRole('radio', { name: 'Dre' });
    await userEvent.click(dre);
    expect(onChange).toHaveBeenLastCalledWith('dre');
    expect(dre.getAttribute('aria-checked')).toBe('true');
    // Pressing the chosen one again keeps it chosen.
    await userEvent.click(dre);
    expect(onChange).toHaveBeenCalledOnce();
    expect(dre.getAttribute('aria-checked')).toBe('true');
    expect(group.querySelectorAll('[aria-checked="true"]')).toHaveLength(1);
    await expectAccessible(container);
  });
});

describe('Toast', () => {
  it('announces the note and runs its action', async () => {
    const onUndo = vi.fn();
    render(
      <ToastProvider>
        <Toast
          open
          onOpenChange={() => undefined}
          title="Reminded 9 clients"
          action={{ label: 'Undo', altText: 'Undo the reminders', onClick: onUndo }}
        />
      </ToastProvider>,
    );
    expect(await screen.findByText('Reminded 9 clients')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalledOnce();
  });
});
