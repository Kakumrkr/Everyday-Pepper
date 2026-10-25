import { addDays, fromZoned, toZoned } from '@pepper/contracts';
import { claimMorningRun, type MorningPass, type TenantTx } from '@pepper/db';

// The morning passes' shared clock (S36 drafts, S38a briefing; ADR-0040, ADR-0042): each runs
// once a local day at the business's morning hour (its own setting over the template's).

/** The business's morning hour: its own setting, else its template's. */
export function morningHourOf(own: number | null, templateHour: number): number {
  return own ?? templateHour;
}

/**
 * Claims the business's `pass` for this morning, in the business's time zone: before the hour
 * it waits for it (the due time set to this morning's hour, a first day included); after it,
 * one worker moves the due time to tomorrow's hour and gets `claimed`, the others `not_due`.
 */
export async function claimMorning(
  tx: TenantTx,
  pass: MorningPass,
  business: { timeZone: string; hour: number },
  now: Date,
): Promise<'waiting' | 'not_due' | 'claimed'> {
  const today = toZoned(business.timeZone, now.getTime());
  const morningOf = (offset: number) =>
    new Date(fromZoned(business.timeZone, addDays(today, offset), business.hour * 60));
  if (now < morningOf(0)) {
    await claimMorningRun(tx, pass, now, morningOf(0));
    return 'waiting';
  }
  return (await claimMorningRun(tx, pass, now, morningOf(1))) ? 'claimed' : 'not_due';
}
