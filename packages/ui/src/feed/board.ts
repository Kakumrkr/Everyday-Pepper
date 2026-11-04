import type { FeedItem } from '@pepper/contracts';
import { formatDate } from '../cards/labels.js';
import { formatDuration } from './feed-lines.js';

// Home's card board (S52, ADR-0043): suggestions ranked by the dollars at stake, similar ones
// grouped, so a staff member open all week is one card and not seven, and the regulars who are
// due are one card with each of them under it. Pure: the words and the order, from the items.

/** A suggestion as the board reads it: the dollars at stake, when the api priced it. */
export type BoardItem = FeedItem & { valueCents?: number | null };

/** The kinds the board groups, and by what. */
export type BoardGroupKind = 'schedule_gaps' | 'rebooking_due';

export type BoardCard =
  | { type: 'single'; key: string; item: BoardItem; valueCents: number | null }
  | {
      type: 'group';
      key: string;
      kind: BoardGroupKind;
      /** Gaps by day, regulars by value (the most first). */
      items: BoardItem[];
      valueCents: number | null;
    };

const valueOf = (item: BoardItem) => item.valueCents ?? null;

/** The sum of the known values, `null` when none is known. */
function total(items: readonly BoardItem[]): number | null {
  const known = items.map(valueOf).filter((value): value is number => value !== null);
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
}

function groupKeyOf(item: BoardItem): string | null {
  if (item.kind === 'schedule_gaps' && item.subjects.staffMemberId !== null) {
    return `schedule_gaps:${item.subjects.staffMemberId}`;
  }
  if (item.kind === 'rebooking_due') return 'rebooking_due';
  return null;
}

const byValue = (a: BoardItem, b: BoardItem) => (valueOf(b) ?? -1) - (valueOf(a) ?? -1);

/**
 * The board: a staff member's open days as one card, the regulars who are due as one card
 * (each only when there are two or more), the rest one card each; ranked by dollars, the most
 * first, and the cards without a value after them in the order they came (newest first).
 */
export function boardOf(items: readonly BoardItem[]): BoardCard[] {
  const groups = new Map<string, BoardItem[]>();
  const order: (string | BoardItem)[] = [];
  for (const item of items) {
    const key = groupKeyOf(item);
    if (key === null) {
      order.push(item);
      continue;
    }
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [item]);
      order.push(key);
    } else {
      group.push(item);
    }
  }
  const cards = order.map((entry): BoardCard => {
    if (typeof entry !== 'string') {
      return { type: 'single', key: entry.id, item: entry, valueCents: valueOf(entry) };
    }
    const members = groups.get(entry) ?? [];
    const [only] = members;
    if (members.length === 1 && only !== undefined) {
      return { type: 'single', key: only.id, item: only, valueCents: valueOf(only) };
    }
    const kind: BoardGroupKind = entry === 'rebooking_due' ? 'rebooking_due' : 'schedule_gaps';
    const sorted =
      kind === 'schedule_gaps'
        ? [...members].sort((a, b) => a.day.localeCompare(b.day))
        : [...members].sort(byValue);
    return { type: 'group', key: entry, kind, items: sorted, valueCents: total(members) };
  });
  // A stable sort: equal values (and every unpriced card) keep the order they came in.
  return cards
    .map((card, index) => ({ card, index }))
    .sort((a, b) => (b.card.valueCents ?? -1) - (a.card.valueCents ?? -1) || a.index - b.index)
    .map(({ card }) => card);
}

const plural = (n: number, one: string, many = `${one}s`) => `${String(n)} ${n === 1 ? one : many}`;

/** "Maria, Lee and Sam", "Maria, Lee, Sam and 3 more". */
export function namesList(names: readonly string[], shown = 3): string {
  if (names.length <= shown) {
    return names.length <= 1
      ? (names[0] ?? '')
      : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
  }
  return `${names.slice(0, shown).join(', ')} and ${String(names.length - shown)} more`;
}

/** A group card's words: its title and why, from its items. */
export function groupLine(card: Extract<BoardCard, { type: 'group' }>): {
  title: string;
  why: string;
} {
  if (card.kind === 'schedule_gaps') {
    const staff = card.items[0]?.names.staff ?? 'A team member';
    const minutes = card.items.reduce(
      (sum, item) => sum + (item.kind === 'schedule_gaps' ? item.payload.openMinutes : 0),
      0,
    );
    return {
      title: `${staff} has ${formatDuration(minutes)} open over the next ${plural(card.items.length, 'day')}`,
      why: 'Inside working hours, from now on. A day goes away when it’s booked or it ends.',
    };
  }
  const names = card.items.map((item) => item.names.client ?? 'A client');
  return {
    title: `${plural(card.items.length, 'regular')} ${card.items.length === 1 ? 'is' : 'are'} due back`,
    why: `${namesList(names)}. Each is past their usual time, with nothing booked yet.`,
  };
}

/** One row under a group card: the day and its open time, or the client and their service. */
export function groupRowLine(item: BoardItem): string {
  if (item.kind === 'schedule_gaps') {
    return `${formatDate(item.day)} · ${formatDuration(item.payload.openMinutes)} open`;
  }
  const client = item.names.client ?? 'A client';
  return item.names.service === null ? client : `${client} · ${item.names.service}`;
}
