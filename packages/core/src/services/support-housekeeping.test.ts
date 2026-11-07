import { describe, expect, it } from 'vitest';
import { isOverdue, overdueEmail, waitedHours } from './support-housekeeping.js';

// The support job's rules (S59.2.2, AC-X-25), without a database.

const at = (iso: string) => new Date(iso);

describe('isOverdue', () => {
  const cutoff = at('2026-11-10T13:00:00Z');
  it('is a wait on Pepper since the cutoff, not reminded of this wait', () => {
    const waiting = {
      status: 'waiting_on_pepper' as const,
      waitingSince: at('2026-11-10T09:00:00Z'),
      overdueRemindedAt: null,
    };
    expect(isOverdue(waiting, cutoff)).toBe(true);
    expect(isOverdue({ ...waiting, waitingSince: at('2026-11-10T13:00:01Z') }, cutoff)).toBe(false);
    expect(isOverdue({ ...waiting, status: 'pepper_replied' }, cutoff)).toBe(false);
    expect(isOverdue({ ...waiting, overdueRemindedAt: at('2026-11-10T13:00:00Z') }, cutoff)).toBe(
      false,
    );
    // Reminded of an earlier wait: this one is new.
    expect(isOverdue({ ...waiting, overdueRemindedAt: at('2026-11-09T13:00:00Z') }, cutoff)).toBe(
      true,
    );
  });
});

describe('waitedHours', () => {
  it('says whole hours, never under the 4 h it reminds at', () => {
    expect(waitedHours(at('2026-11-10T09:00:00Z'), at('2026-11-10T13:00:00Z'))).toBe('4 h');
    expect(waitedHours(at('2026-11-10T09:00:00Z'), at('2026-11-11T11:59:00Z'))).toBe('26 h');
    expect(waitedHours(at('2026-11-10T09:00:00Z'), at('2026-11-10T09:30:00Z'))).toBe('4 h');
  });
});

describe('overdueEmail', () => {
  it('names the request, the business and the link, never the message', () => {
    const mail = overdueEmail({
      reference: 'PEP-7K3Q9D',
      kind: 'question',
      business: 'Juniper',
      waited: '5 h',
      link: 'https://app.pepper.test/ops/threads/1',
    });
    expect(mail.subject).toBe('[PEP-7K3Q9D] Waiting 5 h: answer it today — Juniper');
    expect(mail.text).toContain('PEP-7K3Q9D · A question · Juniper');
    expect(mail.text).toContain('Open it in the console: https://app.pepper.test/ops/threads/1');
  });

  it('says "Signed-out" for the public form and goes without a link', () => {
    const mail = overdueEmail({
      reference: 'PEP-7K3Q9D',
      kind: null,
      business: null,
      waited: '4 h',
      link: null,
    });
    expect(mail.subject).toContain('— Signed-out');
    expect(mail.text).toContain('Public form · Signed-out');
    expect(mail.text).toContain('Open it in the console.');
  });
});
