import { describe, expect, it } from 'vitest';
import { ResendWebhookEventSchema } from './inbound-email.js';
import {
  OperatorHeldDecisionSchema,
  OperatorHeldItemSchema,
  OperatorInboundCountsSchema,
  SupportMailStopSchema,
} from './support.js';

// Email, part 2 (S59.3.2, ADR-0063 Part 2): the webhook's delivery-problem events and the
// console's held review and counts.

describe('ResendWebhookEventSchema (bounces and complaints)', () => {
  it('reads a bounce’s recipients and kind, and passes unknown fields through', () => {
    const event = ResendWebhookEventSchema.parse({
      type: 'email.bounced',
      created_at: '2026-11-08T10:00:00.000Z',
      data: {
        email_id: 'em_1',
        to: ['owner@example.test'],
        bounce: { type: 'Permanent', subType: 'General', message: 'No such user' },
        subject: 'Your request PEP-7K2M9Q',
      },
    });
    expect(event.data.to).toEqual(['owner@example.test']);
    expect(event.data.bounce?.type).toBe('Permanent');
  });

  it('refuses an oversized recipient list', () => {
    const to = Array.from({ length: 51 }, (_, i) => `a${String(i)}@example.test`);
    expect(
      ResendWebhookEventSchema.safeParse({ type: 'email.complained', data: { to } }).success,
    ).toBe(false);
  });
});

describe('the held review (AC-X-44)', () => {
  it('takes only accept or discard', () => {
    expect(OperatorHeldDecisionSchema.parse({ decision: 'accept' })).toEqual({
      decision: 'accept',
    });
    expect(OperatorHeldDecisionSchema.safeParse({ decision: 'land' }).success).toBe(false);
    expect(
      OperatorHeldDecisionSchema.safeParse({ decision: 'discard', tenantId: 'x' }).success,
    ).toBe(false);
  });

  it('describes a stranger’s held new request without a business', () => {
    expect(
      OperatorHeldItemSchema.parse({
        id: '0195a3b2-8c4d-7e6f-9a0b-1c2d3e4f5a6b',
        reason: 'unverified_sender',
        kind: 'new_request',
        from: 'someone@else.test',
        subject: 'Can’t sign in',
        text: 'Hello',
        business: null,
        reference: null,
        heldSince: '2026-11-08T10:00:00.000Z',
      }).business,
    ).toBeNull();
  });
});

describe('counts and stops (AC-X-43, AC-X-45)', () => {
  it('has both periods and the delivery problems', () => {
    const period = {
      outcomes: [{ status: 'landed', reason: 'new_request', count: 2 }],
      problems: { hardBounces: 1, softBounces: 0, complaints: 0 },
    };
    expect(
      OperatorInboundCountsSchema.parse({ last7Days: period, last30Days: period }).last7Days
        .outcomes[0]?.count,
    ).toBe(2);
    expect(
      OperatorInboundCountsSchema.safeParse({
        last7Days: { ...period, outcomes: [{ status: 'opened', reason: null, count: 1 }] },
        last30Days: period,
      }).success,
    ).toBe(false);
  });

  it('names why mail stopped', () => {
    expect(
      SupportMailStopSchema.safeParse({ reason: 'bounced', since: '2026-11-08T10:00:00.000Z' })
        .success,
    ).toBe(true);
    expect(
      SupportMailStopSchema.safeParse({ reason: 'soft', since: '2026-11-08T10:00:00.000Z' })
        .success,
    ).toBe(false);
  });
});
