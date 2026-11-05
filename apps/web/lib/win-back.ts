import type { WinBackClient, WinBackRefusal, WinBackResponse } from '@pepper/contracts';
import { formatMoney } from '@pepper/ui';

// "Haven't been back" (S54.2, ADR-0057; AC-W4-6…9): the screen's address and its words.

export const WIN_BACK_PATH = '/clients/win-back';
/** Where the business's mailing address is set (More, "Rebooking emails"). */
export const MAILING_ADDRESS_PATH = '/more#rebooking-heading';

/**
 * The post-import line (AC-W4-8): "12 regulars are overdue, about $540"; without dollars when
 * none are priced; `null` when no one is overdue.
 */
export function ahaSentence(answer: Pick<WinBackResponse, 'count' | 'totalCents'>): string | null {
  if (answer.count === 0) return null;
  const who =
    answer.count === 1 ? '1 regular is overdue' : `${String(answer.count)} regulars are overdue`;
  return answer.totalCents > 0 ? `${who}, about ${formatMoney(answer.totalCents)}` : who;
}

const SHORT_DATE = (timeZone: string) =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone });

/** "Haircut with Jess · last in Aug 29 · 12 days overdue". */
export function rowMeta(client: WinBackClient, timeZone: string): string {
  const what =
    client.serviceName === null
      ? null
      : client.staffName === null
        ? client.serviceName
        : `${client.serviceName} with ${client.staffName.trim().split(/\s+/)[0] ?? client.staffName}`;
  const last = `last visit ${SHORT_DATE(timeZone).format(new Date(client.lastVisitAt))}`;
  const late =
    client.daysOverdue === 0
      ? 'due today'
      : client.daysOverdue === 1
        ? '1 day overdue'
        : `${String(client.daysOverdue)} days overdue`;
  return [what, last, late].filter((part) => part !== null).join(' · ');
}

/** Why a row offers no "Draft email", or `null` when it does. */
export function blockedReason(
  client: WinBackClient,
  timeZone: string,
  mailingAddressSet: boolean,
): string | null {
  if (client.reach === 'opted_out') return 'Unsubscribed from emails';
  if (client.reach === 'no_email') return 'No email on file';
  if (client.emailedAt !== null) {
    return `Emailed ${SHORT_DATE(timeZone).format(new Date(client.emailedAt))}`;
  }
  if (!mailingAddressSet) return 'Add your mailing address first';
  return null;
}

/** A refused draft, in words that say what happens instead. */
export function refusalText(reason: WinBackRefusal): string {
  switch (reason) {
    case 'not_due':
      return 'They’re not overdue any more, so I didn’t write it.';
    case 'no_email':
      return 'There’s no email for them. Add one on their profile.';
    case 'opted_out':
      return 'They unsubscribed from emails, so I won’t write to them.';
    case 'no_address':
      return 'Add your mailing address first: every email like this carries it.';
    case 'recently_emailed':
      return 'They had an email from you in the last 4 weeks. I’ll leave them be for now.';
    case 'daily_limit':
      return 'That’s 20 drafts today. I’ll be ready for more tomorrow.';
    case 'no_time':
      return 'I couldn’t find an open time for their service in the next week.';
  }
}
