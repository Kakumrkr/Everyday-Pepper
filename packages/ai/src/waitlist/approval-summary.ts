import type { ActionProposal } from '@pepper/contracts';
import { z } from 'zod';
import { clientFirstName } from '../tools/names.js';

// The waitlist offer's card in one line for the owner's text (S63, ADR-0066 §3, AC-X-82):
// "Tue 2pm opened with Jess. Offer it to Audy, Marco and Sam?" From the stored proposal only
// (its preview and *Why?* facts), first names only: no last name, number, email or price.

const After = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  staffName: z.string(),
});
const Fact = z.object({ kind: z.string(), value: z.object({ clientName: z.string() }).loose() });

/** The most first names a text lists; the rest are "and 2 more". */
const NAMES_SHOWN = 3;

export function waitlistOfferSummary(
  proposal: Pick<ActionProposal, 'preview' | 'explanation'>,
): string {
  const preview = z.object({ after: After }).loose().safeParse(proposal.preview);
  const names = proposal.explanation.facts.flatMap((fact) => {
    const parsed = Fact.safeParse(fact);
    if (!parsed.success || !['waitlist_rank', 'rebooking_due'].includes(parsed.data.kind))
      return [];
    const first = clientFirstName(parsed.data.value.clientName);
    return first === null ? [] : [first];
  });
  const who = list(names);
  if (!preview.success) return `A freed time can go to the waitlist. Offer it to ${who}?`;
  const { date, time, staffName } = preview.data.after;
  const staff = clientFirstName(staffName);
  return `${weekday(date)} ${clock(time)} opened${staff === null ? '' : ` with ${staff}`}. Offer it to ${who}?`;
}

function list(names: readonly string[]): string {
  if (names.length === 0) return 'the waitlist';
  const shown = names.slice(0, NAMES_SHOWN);
  const more = names.length - shown.length;
  if (more > 0) return `${shown.join(', ')} and ${String(more)} more`;
  if (shown.length === 1) return shown.join('');
  return `${shown.slice(0, -1).join(', ')} and ${shown.at(-1) ?? ''}`;
}

/** "Tue" for a calendar date (the business's own, as the preview gives it). */
function weekday(date: string): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(
    new Date(`${date}T12:00:00Z`),
  );
}

/** "2pm", "2:30pm", "12pm" from "14:00", "14:30", "12:00". */
function clock(time: string): string {
  const [hours = 0, minutes = 0] = time.split(':').map(Number);
  const half = hours >= 12 ? 'pm' : 'am';
  const hour = hours % 12 === 0 ? 12 : hours % 12;
  return minutes === 0
    ? `${String(hour)}${half}`
    : `${String(hour)}:${String(minutes).padStart(2, '0')}${half}`;
}
