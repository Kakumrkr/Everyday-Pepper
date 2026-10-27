// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BottomTabBar,
  BriefingBlock,
  Card,
  DetailTable,
  EmptyState,
  List,
  ListRow,
  Receipt,
  Stat,
  StepBar,
  StickyActionBar,
  TimeChip,
  type KitLink,
} from './blocks.js';
import { Button } from './button.js';

afterEach(cleanup);

async function expectAccessible(container: HTMLElement): Promise<void> {
  const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
  expect(result.violations.map((violation) => violation.id)).toEqual([]);
}

describe('Card', () => {
  it('is raised and named by its heading', async () => {
    const { container } = render(
      <Card labelledBy="t">
        <h2 id="t">Give 1:15 to Jaylen Brooks?</h2>
      </Card>,
    );
    const card = screen.getByRole('region', { name: 'Give 1:15 to Jaylen Brooks?' });
    expect(card.className).toContain('shadow-raised');
    await expectAccessible(container);
  });
});

describe('ListRow', () => {
  it('shows a time, a title, meta and an amount as one quiet row', async () => {
    const { container } = render(
      <List label="Dre's day">
        <ListRow leading="9:45" title="Andre Wallace" meta="Skin fade" trailing="$45" />
      </List>,
    );
    const row = within(screen.getByRole('list', { name: "Dre's day" })).getByRole('listitem');
    expect(row.textContent).toBe('9:45Andre WallaceSkin fade$45');
    expect(screen.queryByRole('link')).toBeNull();
    await expectAccessible(container);
  });

  it('is one link with a chevron when it navigates, through the screen’s own link', async () => {
    const renderLink: KitLink = ({ href, className, children }) => (
      <a href={href} className={className} data-next="yes">
        {children}
      </a>
    );
    const { container } = render(
      <List>
        <ListRow
          title="Marcus Bell"
          meta="2 weeks overdue"
          href="/clients/mb"
          renderLink={renderLink}
        />
      </List>,
    );
    const link = screen.getByRole('link', { name: /Marcus Bell/ });
    expect(link.getAttribute('href')).toBe('/clients/mb');
    expect(link.getAttribute('data-next')).toBe('yes');
    expect(link.querySelectorAll('svg')).toHaveLength(1);
    await expectAccessible(container);
  });
});

describe('DetailTable', () => {
  it('pairs each label with its value', async () => {
    const { container } = render(
      <DetailTable
        rows={[
          { label: 'Time', value: 'Today 4:15' },
          { label: "Who's told", value: 'Darius gets an email' },
        ]}
      />,
    );
    const terms = [...container.querySelectorAll('dt')].map((dt) => dt.textContent);
    const details = [...container.querySelectorAll('dd')].map((dd) => dd.textContent);
    expect(terms).toEqual(['Time', "Who's told"]);
    expect(details).toEqual(['Today 4:15', 'Darius gets an email']);
    await expectAccessible(container);
  });
});

describe('Stat', () => {
  it('sets the one big number in tabular figures', () => {
    render(<Stat value="$430" label="Booked today" size="xl" />);
    expect(screen.getByText('$430').className).toContain('type-number-xl');
    expect(screen.getByText('$430').className).toContain('tabular-nums');
  });
});

describe('EmptyState', () => {
  it('always offers the next step, as a link or a button', async () => {
    const onClick = vi.fn();
    const { container } = render(
      <div>
        <EmptyState
          icon="services"
          title="No services yet"
          body="Add what you offer and clients can book it."
          action={{ label: 'Add your first service', href: '/services/new' }}
        />
        <EmptyState
          title="No one on the waitlist"
          body="When a day is full, clients can ask to hear about openings."
          action={{ label: 'Share the booking page', onClick }}
        />
      </div>,
    );
    expect(screen.getByRole('link', { name: 'Add your first service' }).getAttribute('href')).toBe(
      '/services/new',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Share the booking page' }));
    expect(onClick).toHaveBeenCalledOnce();
    await expectAccessible(container);
  });
});

describe('Receipt', () => {
  it('announces what was done and offers Undo with its deadline', async () => {
    const onUndo = vi.fn();
    const { container } = render(
      <Receipt undo={{ onUndo, until: '9:50' }}>Moved Darius Hill to 4:15</Receipt>,
    );
    expect(screen.getByRole('status').textContent).toContain('Moved Darius Hill to 4:15');
    await userEvent.click(screen.getByRole('button', { name: 'Undo, until 9:50' }));
    expect(onUndo).toHaveBeenCalledOnce();
    await expectAccessible(container);
  });

  it('has no Undo once it can’t be undone', () => {
    render(<Receipt>Reminded 9 clients</Receipt>);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('TimeChip', () => {
  it('says whether it is the chosen time', async () => {
    const onSelect = vi.fn();
    const { container } = render(
      <div>
        <TimeChip time="4:00" onSelect={onSelect} />
        <TimeChip time="4:15" selected onSelect={() => undefined} />
      </div>,
    );
    expect(screen.getByRole('button', { name: '4:15' }).getAttribute('aria-pressed')).toBe('true');
    await userEvent.click(screen.getByRole('button', { name: '4:00' }));
    expect(onSelect).toHaveBeenCalledOnce();
    await expectAccessible(container);
  });
});

describe('StepBar', () => {
  it('marks the current step and the done ones', async () => {
    const { container } = render(<StepBar steps={['Service', 'Time', 'Details']} current={1} />);
    const steps = screen.getAllByRole('listitem');
    expect(steps.map((s) => s.textContent)).toEqual(['Service, done', 'Time', 'Details']);
    expect(steps[1]?.getAttribute('aria-current')).toBe('step');
    expect(screen.getByText('Step 2 of 3 · Time')).toBeTruthy();
    await expectAccessible(container);
  });
});

describe('StickyActionBar', () => {
  it('holds the summary, Back and the one primary action, fixed at the bottom', async () => {
    const back = vi.fn();
    const { container } = render(
      <StickyActionBar
        summary="Skin fade · Today 4:15 · $45"
        back={{ label: 'Back', onClick: back }}
        primary={<Button>Book</Button>}
      />,
    );
    expect((container.firstElementChild as HTMLElement).className).toContain('fixed');
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(back).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Book' })).toBeTruthy();
    await expectAccessible(container);
  });
});

describe('BriefingBlock', () => {
  it('shows the day’s number and how full the day is, clamped to 0–100', async () => {
    const { container, rerender } = render(
      <BriefingBlock
        greeting="Morning, Dre"
        value="$430"
        valueLabel="Booked today · 12 visits"
        progress={0.78}
        progressLabel="78% full · 2 gaps"
      />,
    );
    const bar = screen.getByRole('progressbar', { name: '78% full · 2 gaps' });
    expect(bar.getAttribute('aria-valuenow')).toBe('78');
    await expectAccessible(container);
    rerender(
      <BriefingBlock greeting="g" value="v" valueLabel="l" progress={1.4} progressLabel="p" />,
    );
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
  });
});

describe('BottomTabBar', () => {
  it('marks the current tab for screen readers', async () => {
    const { container } = render(
      <BottomTabBar
        current="home"
        items={[
          { key: 'home', label: 'Home', icon: 'home', href: '/' },
          { key: 'calendar', label: 'Calendar', icon: 'calendar', href: '/calendar' },
          { key: 'more', label: 'More', icon: 'more', href: '/more' },
        ]}
      />,
    );
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Calendar' }).hasAttribute('aria-current')).toBe(
      false,
    );
    await expectAccessible(container);
  });
});
