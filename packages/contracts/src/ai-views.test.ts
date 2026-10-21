import { describe, expect, it } from 'vitest';
import {
  AiActionViewSchema,
  AiProposalViewSchema,
  ApproveProposalRequestSchema,
  ApproveProposalResponseSchema,
  ChatStatusSchema,
  UndoActionRequestSchema,
  UndoRefusedBodySchema,
} from './ai-views.js';
import { ScreenLinkSchema } from './chat.js';
import { ToolCardSchema } from './tool-cards.js';

const ID = '0199f4b2-7c1e-7a00-8000-0000000000a1';
const FINGERPRINT = 'a'.repeat(64);
const AT = '2026-10-21T10:00:00.000Z';

const why = {
  asked: { kind: 'message', text: 'Book Maria Friday at 4' },
  steps: [{ tool: 'create_booking' }],
  decision: { outcome: 'propose', reason: 'setting' },
  untrustedContext: false,
};

const proposal = {
  id: ID,
  action: 'booking.create',
  tool: 'create_booking',
  status: 'pending',
  fingerprint: FINGERPRINT,
  summary: 'New booking: Maria L., Colour with Jess, Fri 2026-10-23 at 17:15.',
  before: null,
  after: { date: '2026-10-23', time: '17:15', clientName: 'Maria L.' },
  emails: [{ template: 'confirmed', clientId: ID }],
  expiresAt: AT,
  createdAt: AT,
  executionId: null,
  decidedByName: null,
  forYou: true,
  canDecide: true,
  why,
};

const action = {
  id: ID,
  proposalId: ID,
  action: 'booking.create',
  tool: 'create_booking',
  outcome: 'propose',
  status: 'done',
  summary: 'New booking: Maria L., Colour with Jess, Fri 2026-10-23 at 17:15.',
  before: null,
  after: { date: '2026-10-23', time: '17:15' },
  emails: [{ template: 'confirmed', clientId: ID, status: 'waiting', sendsAt: AT }],
  createdAt: AT,
  undoUntil: AT,
  canUndo: true,
  undoneAt: null,
  undoReason: null,
  approvedByName: 'Ana',
  forYou: true,
  why,
};

describe('AiProposalViewSchema and AiActionViewSchema', () => {
  it('parse a proposal and a receipt as the cards show them', () => {
    expect(AiProposalViewSchema.parse(proposal)).toEqual(proposal);
    expect(AiActionViewSchema.parse(action)).toEqual(action);
  });

  it('never carry a client contact in a change side', () => {
    expect(
      AiActionViewSchema.safeParse({ ...action, after: { email: 'maria@example.com' } }).success,
    ).toBe(false);
    expect(
      AiProposalViewSchema.safeParse({ ...proposal, summary: 'Call Maria on 555 123 4567' })
        .success,
    ).toBe(false);
  });

  it('shows the member their own words only, or says they are not shown', () => {
    for (const asked of [{ kind: 'not_shown' }, { kind: 'none' }]) {
      expect(AiProposalViewSchema.parse({ ...proposal, why: { ...why, asked } }).why.asked).toEqual(
        asked,
      );
    }
    expect(
      AiProposalViewSchema.safeParse({ ...proposal, why: { ...why, asked: { kind: 'html' } } })
        .success,
    ).toBe(false);
  });
});

describe('ApproveProposal', () => {
  it('approves by the fingerprint the card showed, nothing else', () => {
    expect(ApproveProposalRequestSchema.parse({ fingerprint: FINGERPRINT })).toEqual({
      fingerprint: FINGERPRINT,
    });
    expect(ApproveProposalRequestSchema.safeParse({ fingerprint: 'abc' }).success).toBe(false);
    expect(
      ApproveProposalRequestSchema.safeParse({ fingerprint: FINGERPRINT, payload: {} }).success,
    ).toBe(false);
  });

  it('answers executed, stale with the fresh proposal, refused with a code, or expired', () => {
    const answers = [
      { kind: 'executed', action },
      { kind: 'stale', proposal },
      {
        kind: 'refused',
        code: 'slot_unavailable',
        message: 'That time was just taken.',
        card: null,
      },
      { kind: 'expired' },
    ];
    for (const answer of answers) {
      expect(ApproveProposalResponseSchema.parse(answer)).toEqual(answer);
    }
  });
});

describe('Undo', () => {
  it('takes only a reason', () => {
    expect(UndoActionRequestSchema.parse({ reason: null })).toEqual({ reason: null });
    expect(UndoActionRequestSchema.safeParse({ reason: 'wrong', executionId: ID }).success).toBe(
      false,
    );
  });

  it('says why an undo was refused with a stable reason', () => {
    expect(
      UndoRefusedBodySchema.parse({ code: 'undo_refused', message: 'x', reason: 'slot_taken' }),
    ).toMatchObject({ reason: 'slot_taken' });
  });
});

describe('ChatStatusSchema', () => {
  it('is on, off or paused', () => {
    expect(ChatStatusSchema.parse({ state: 'paused' })).toEqual({ state: 'paused' });
    expect(ChatStatusSchema.safeParse({ state: 'maybe' }).success).toBe(false);
  });
});

describe('the change card summary', () => {
  const card = {
    kind: 'change',
    tool: 'create_booking',
    action: 'booking.create',
    state: 'proposed',
    proposalId: ID,
    fingerprint: FINGERPRINT,
    executionId: null,
    undoUntil: null,
    before: null,
    after: null,
    emails: [],
  };

  it('is optional, so cards stored before S26 still parse', () => {
    expect(ToolCardSchema.parse(card)).toEqual(card);
    expect(ToolCardSchema.parse({ ...card, summary: 'Booked.' })).toMatchObject({
      summary: 'Booked.',
    });
  });
});

describe('ScreenLinkSchema (S26 hardening)', () => {
  it('refuses a protocol-relative link that would leave the app', () => {
    expect(ScreenLinkSchema.safeParse({ label: 'x', href: '//evil' }).success).toBe(false);
    expect(ScreenLinkSchema.safeParse({ label: 'x', href: '/calendar//x' }).success).toBe(false);
    expect(ScreenLinkSchema.parse({ label: 'Calendar', href: '/calendar' })).toEqual({
      label: 'Calendar',
      href: '/calendar',
    });
    expect(ScreenLinkSchema.parse({ label: 'Home', href: '/' }).href).toBe('/');
  });
});
