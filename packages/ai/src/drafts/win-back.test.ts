import { describe, expect, it } from 'vitest';
import { firstAnswer, winBackWords } from './win-back-words.js';

// The words of a one-tap win-back email (S54.2, ADR-0057): written by the domain from the first
// name, the service and the last visit's date, always inside the draft rules.

describe('the words', () => {
  it('stay inside the draft rules, with or without a first name', () => {
    expect(
      winBackWords({ firstName: null, serviceName: 'Gel Manicure', lastVisit: 'May 3' }),
    ).toEqual({
      subject: 'Time for your next gel manicure?',
      body: "Hi,\n\nIt's been a while since your last gel manicure on May 3, and we'd love to see you again.",
    });
    // A name a draft rule refuses (too long, or read as a link) leaves the name and service out.
    for (const serviceName of ['Signature '.repeat(12), 'lash.me refill']) {
      expect(winBackWords({ firstName: 'Ana', serviceName, lastVisit: 'May 3' })).toEqual({
        subject: 'Time for your next visit?',
        body: "Hi,\n\nIt's been a while since your last visit on May 3, and we'd love to see you again.",
      });
    }
  });
});

describe('the first answer to a tap (AC-W4-7)', () => {
  const ready = {
    pendingProposalId: null,
    optedOut: false,
    hasEmail: true,
    emailedAt: null,
    serviceBookable: true,
  };
  const PROPOSAL = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f700099';

  it('goes on for a client who can be emailed', () => {
    expect(firstAnswer(ready, true)).toBeNull();
  });

  it('opens the draft that waits, before anything else', () => {
    expect(firstAnswer({ ...ready, pendingProposalId: PROPOSAL, optedOut: true }, false)).toEqual({
      kind: 'drafted',
      proposalId: PROPOSAL,
    });
  });

  it('refuses in order: not due, no address, unsubscribed, no email, emailed, hidden service', () => {
    const reason = (answer: ReturnType<typeof firstAnswer>) =>
      answer?.kind === 'refused' ? answer.reason : answer?.kind;
    expect(reason(firstAnswer(undefined, true))).toBe('not_due');
    expect(reason(firstAnswer({ ...ready, optedOut: true }, false))).toBe('no_address');
    expect(reason(firstAnswer({ ...ready, optedOut: true, hasEmail: false }, true))).toBe(
      'opted_out',
    );
    expect(reason(firstAnswer({ ...ready, hasEmail: false }, true))).toBe('no_email');
    expect(reason(firstAnswer({ ...ready, emailedAt: new Date() }, true))).toBe('recently_emailed');
    expect(reason(firstAnswer({ ...ready, serviceBookable: false }, true))).toBe('service_hidden');
  });
});
