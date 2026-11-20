import 'reflect-metadata';
import type { Server } from 'node:http';
import { ApiErrorSchema } from '@pepper/contracts';
import { ForbiddenError, ProposalChangedError, ProposalNotPendingError } from '@pepper/core';
import type * as Appointments from '@pepper/appointments';
import type * as Core from '@pepper/core';
import type * as Db from '@pepper/db';
import { DATABASE } from '@pepper/runtime';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SameOriginGuard } from '../auth/guards.js';
import { AiActionsService } from '../chat/ai-actions.service.js';
import { RateLimiter } from '../http/rate-limit.js';
import { APPROVAL_REPLIES } from './sms-inbound.service.js';
import { SmsWebhookModule } from './sms-webhook.controller.js';
import { twilioSignatureOf } from './twilio-signature.js';

// Twilio's SMS webhooks without a database (S61, AC-X-59, AC-X-61, AC-X-62): no session and no
// Origin; the signature over the public URL and the form decides; the account must be ours; a
// keyword's reply is TwiML; a status names its business and message in the signed query; off
// without Twilio. core's sms.int.test.ts proves what the calls do.

const core = vi.hoisted(() => ({
  handleInboundSms: vi.fn(),
  recordSmsStatus: vi.fn(),
  claimApprovalText: vi.fn(),
  recordTextApproval: vi.fn(),
}));
vi.mock('@pepper/core', async (original) => ({
  ...(await original<typeof Core>()),
  handleInboundSms: core.handleInboundSms,
  recordSmsStatus: core.recordSmsStatus,
  claimApprovalText: core.claimApprovalText,
  recordTextApproval: core.recordTextApproval,
}));
const db = vi.hoisted(() => ({ isSmsOptedOut: vi.fn(), isMemberPhone: vi.fn() }));
vi.mock('@pepper/db', async (original) => ({
  ...(await original<typeof Db>()),
  isSmsOptedOut: db.isSmsOptedOut,
  isMemberPhone: db.isMemberPhone,
}));
const appointments = vi.hoisted(() => ({ confirmBookingByText: vi.fn() }));
vi.mock('@pepper/appointments', async (original) => ({
  ...(await original<typeof Appointments>()),
  confirmBookingByText: appointments.confirmBookingByText,
}));

const ORIGIN = 'http://localhost:3000';
const BASE = 'https://app.example.test';
const ACCOUNT = `AC${'b'.repeat(32)}`;
const TOKEN = '0123456789abcdef0123456789abcdef';
const NOW = new Date('2026-11-12T17:00:00Z');
const TENANT = '0199f4b2-7c1e-7a00-8000-0000000000a1';
const MESSAGE = '0199f4b2-7c1e-7a00-8000-0000000000b2';

@Global()
@Module({ providers: [{ provide: DATABASE, useValue: { db: {} } }], exports: [DATABASE] })
class FakeConnectionsModule {}

const limits = { hit: vi.fn(() => Promise.resolve()), spent: vi.fn(() => Promise.resolve(false)) };
const approvals = { approve: vi.fn(), skip: vi.fn() };

@Global()
@Module({
  providers: [{ provide: AiActionsService, useValue: approvals }],
  exports: [AiActionsService],
})
class FakeChatModule {}

async function start(twilio: { accountSid: string; authToken: string } | null) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      FakeConnectionsModule,
      FakeChatModule,
      SmsWebhookModule.forRoot({
        twilio,
        baseUrl: BASE,
        outboxKey: Buffer.alloc(32, 7),
        sandbox: false,
        clock: { now: () => NOW },
      }),
    ],
    providers: [
      {
        provide: APP_GUARD,
        useFactory: (reflector: Reflector) => new SameOriginGuard(reflector, ORIGIN),
        inject: [Reflector],
      },
    ],
  })
    .overrideProvider(RateLimiter)
    .useValue(limits)
    .compile();
  const app = moduleRef.createNestApplication({ logger: false, rawBody: true });
  await app.init();
  return app;
}

let app: INestApplication;
let off: INestApplication;
let server: Server;

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

function signature(path: string, body: string, token = TOKEN): string {
  return twilioSignatureOf(token, `${BASE}${path}`, [...new URLSearchParams(body)]);
}

const inbound = (body = 'STOP', extra: Record<string, string> = {}) => ({
  MessageSid: `SM${'a'.repeat(32)}`,
  AccountSid: ACCOUNT,
  From: '+15552340001',
  To: '+15557654321',
  Body: body,
  NumMedia: '0',
  ...extra,
});

function post(path: string, body: string, sig?: string) {
  const call = request(server)
    .post(path)
    .set('Content-Type', 'application/x-www-form-urlencoded')
    .send(body);
  return sig === undefined ? call : call.set('X-Twilio-Signature', sig);
}

beforeAll(async () => {
  app = await start({ accountSid: ACCOUNT, authToken: TOKEN });
  off = await start(null);
  server = app.getHttpServer() as Server;
});

afterAll(async () => {
  await app.close();
  await off.close();
});

beforeEach(() => {
  core.handleInboundSms.mockReset();
  core.recordSmsStatus.mockReset();
  core.handleInboundSms.mockResolvedValue({ keyword: 'stop', reply: 'Pepper: You & "they" <ok>' });
  core.recordSmsStatus.mockResolvedValue('moved');
  core.claimApprovalText.mockReset();
  core.recordTextApproval.mockReset();
  core.recordTextApproval.mockResolvedValue(true);
  approvals.approve.mockReset();
  approvals.skip.mockReset();
  approvals.skip.mockResolvedValue(undefined);
  limits.hit.mockClear();
  limits.spent.mockReset();
  limits.spent.mockResolvedValue(false);
  db.isSmsOptedOut.mockReset();
  db.isSmsOptedOut.mockResolvedValue(false);
  db.isMemberPhone.mockReset();
  db.isMemberPhone.mockResolvedValue(true);
  appointments.confirmBookingByText.mockReset();
  appointments.confirmBookingByText.mockResolvedValue({
    outcome: 'confirmed',
    reply: "Juniper via Pepper: Thanks, you're confirmed",
  });
});

describe('POST /v1/webhooks/sms (AC-X-59, AC-X-61)', () => {
  const path = '/v1/webhooks/sms';

  it('handles a signed text in the request and replies with escaped TwiML', async () => {
    const body = form(inbound('Stop texting me'));
    const response = await post(path, body, signature(path, body)).expect(200);
    expect(response.headers['content-type']).toMatch(/^text\/xml/);
    expect(response.text).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Message>Pepper: You &amp; &quot;they&quot; &lt;ok&gt;</Message></Response>',
    );
    expect(core.handleInboundSms).toHaveBeenCalledWith(
      {},
      {
        provider: 'twilio',
        eventId: `SM${'a'.repeat(32)}`,
        from: '+15552340001',
        body: 'Stop texting me',
        receivedAt: NOW,
      },
      { helpUrl: `${BASE}/help` },
    );
    expect(limits.hit).toHaveBeenCalled();
  });

  it('answers with no reply when core has none (a replay, not a keyword)', async () => {
    core.handleInboundSms.mockResolvedValue({ keyword: null, reply: null });
    const body = form(inbound('Thanks!'));
    const response = await post(path, body, signature(path, body)).expect(200);
    expect(response.text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  });

  it('confirms by "C" in the request and replies with the time (S62, AC-X-74)', async () => {
    core.handleInboundSms.mockResolvedValue({ keyword: null, reply: null });
    const body = form(inbound('c.'));
    const response = await post(path, body, signature(path, body)).expect(200);
    expect(response.text).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Message>Juniper via Pepper: Thanks, you&apos;re confirmed</Message></Response>',
    );
    expect(appointments.confirmBookingByText).toHaveBeenCalledWith(
      {},
      { from: '+15552340001', receivedAt: NOW },
    );
  });

  it('never confirms on a keyword, and answers no reply when the confirm has none', async () => {
    const body = form(inbound('CANCEL'));
    await post(path, body, signature(path, body)).expect(200);
    expect(appointments.confirmBookingByText).not.toHaveBeenCalled();

    core.handleInboundSms.mockResolvedValue({ keyword: null, reply: null });
    appointments.confirmBookingByText.mockResolvedValue({ outcome: 'nothing', reply: null });
    const c = form(inbound('Confirm'));
    const response = await post(path, c, signature(path, c)).expect(200);
    expect(response.text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  });

  describe('"Y" and a code (S63, AC-X-83…86)', () => {
    const TEXT_ID = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f7000aa';
    const EXECUTION = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f7000bb';
    const CLAIMED = {
      kind: 'claimed',
      tenantId: TENANT,
      approvalTextId: TEXT_ID,
      context: { tenantId: TENANT, userId: MESSAGE, role: 'owner' },
      proposalId: MESSAGE,
      fingerprint: 'f'.repeat(64),
    };
    const reply = async (text: string) => {
      core.handleInboundSms.mockResolvedValue({ keyword: null, reply: null });
      const body = form(inbound(text));
      const response = await post(path, body, signature(path, body)).expect(200);
      return /<Message>(.*)<\/Message>/.exec(response.text)?.[1]?.replace(/&apos;/g, "'") ?? null;
    };

    it('claims the code from this number, then approves as its member with what the text showed', async () => {
      core.claimApprovalText.mockResolvedValue(CLAIMED);
      approvals.approve.mockResolvedValue({ kind: 'executed', action: { id: EXECUTION } });
      expect(await reply('Y 4821')).toBe(APPROVAL_REPLIES.done);
      expect(core.claimApprovalText).toHaveBeenCalledWith(
        {},
        { from: '+15552340001', code: '4821', receivedAt: NOW, decision: 'approve' },
        { codeKey: expect.any(Buffer) as Buffer },
      );
      // Only the first approval counts: a card already approved in the app is "handled".
      expect(approvals.approve).toHaveBeenCalledWith(CLAIMED.context, MESSAGE, 'f'.repeat(64), {
        firstOnly: true,
      });
      // Activity's "approved by text" (S63.2, AC-X-91): the text linked to what it did.
      expect(core.recordTextApproval).toHaveBeenCalledWith({}, TENANT, TEXT_ID, EXECUTION);
      expect(appointments.confirmBookingByText).not.toHaveBeenCalled();
    });

    it('still says done when only the Activity link fails (the card is approved)', async () => {
      core.claimApprovalText.mockResolvedValue(CLAIMED);
      approvals.approve.mockResolvedValue({ kind: 'executed', action: { id: EXECUTION } });
      core.recordTextApproval.mockRejectedValueOnce(new Error('connection reset'));
      expect(await reply('Y 4821')).toBe(APPROVAL_REPLIES.done);
    });

    it('links nothing when the approval did not run', async () => {
      core.claimApprovalText.mockResolvedValue(CLAIMED);
      approvals.approve.mockResolvedValueOnce({ kind: 'stale' });
      expect(await reply('Y 4821')).toBe(APPROVAL_REPLIES.changed);
      approvals.approve.mockRejectedValueOnce(new ProposalNotPendingError('approved'));
      expect(await reply('Y 4821')).toBe(APPROVAL_REPLIES.handled);
      expect(core.recordTextApproval).not.toHaveBeenCalled();
    });

    it('answers a changed, refused, expired or handled card without running it', async () => {
      core.claimApprovalText.mockResolvedValue(CLAIMED);
      for (const [result, words] of [
        [{ kind: 'stale' }, APPROVAL_REPLIES.changed],
        [{ kind: 'refused' }, APPROVAL_REPLIES.refused],
        [{ kind: 'expired' }, APPROVAL_REPLIES.expired],
      ] as const) {
        approvals.approve.mockResolvedValueOnce(result);
        expect(await reply('y4821')).toBe(words);
      }
      approvals.approve.mockRejectedValueOnce(new ProposalNotPendingError('approved'));
      expect(await reply('Y 4821')).toBe(APPROVAL_REPLIES.handled);
      approvals.approve.mockRejectedValueOnce(new ForbiddenError());
      expect(await reply('Y 4821')).toBe(APPROVAL_REPLIES.miss);
      // Anything else: the code is spent, so it says it didn't (never a 500 that Twilio retries
      // into "already done").
      approvals.approve.mockRejectedValueOnce(new Error('connection reset'));
      expect(await reply('Y 4821')).toBe(APPROVAL_REPLIES.refused);
    });

    it('answers a replay "already done" and a spoof one miss answer, counted per number', async () => {
      core.claimApprovalText.mockResolvedValueOnce({ kind: 'used' });
      expect(await reply('Y 4821')).toBe(APPROVAL_REPLIES.used);
      core.claimApprovalText.mockResolvedValueOnce({ kind: 'expired' });
      expect(await reply('Y 4821')).toBe(APPROVAL_REPLIES.expired);
      core.claimApprovalText.mockResolvedValueOnce({ kind: 'miss' });
      expect(await reply('Y 4821')).toBe(APPROVAL_REPLIES.miss);
      expect(limits.hit).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'sms-approval-miss', max: 5 }),
        expect.stringMatching(/^[0-9a-f]{64}$/),
      );
      expect(approvals.approve).not.toHaveBeenCalled();
    });

    it('stops looking after 5 misses an hour, and answers nothing after a STOP', async () => {
      limits.spent.mockResolvedValueOnce(true);
      expect(await reply('Y 4821')).toBe(APPROVAL_REPLIES.miss);
      expect(core.claimApprovalText).not.toHaveBeenCalled();
      db.isSmsOptedOut.mockResolvedValue(true);
      expect(await reply('Y 4821')).toBeNull();
      expect(await reply('Y')).toBeNull();
      expect(core.claimApprovalText).not.toHaveBeenCalled();
    });

    it('tells a bare "Y" how to reply, and leaves YES a keyword', async () => {
      expect(await reply('Y')).toBe(APPROVAL_REPLIES.withoutCode);
      // A client's "Y" to a reminder: no reply, as before S63.
      db.isMemberPhone.mockResolvedValueOnce(false);
      expect(await reply('Y')).toBeNull();
      core.handleInboundSms.mockResolvedValue({ keyword: 'start', reply: 'Pepper: resubscribed' });
      const body = form(inbound('YES'));
      const response = await post(path, body, signature(path, body)).expect(200);
      expect(response.text).toContain('Pepper: resubscribed');
      expect(core.claimApprovalText).not.toHaveBeenCalled();
    });
  });

  describe('"N" and a code (S64, AC-X-93, AC-X-94)', () => {
    const CLAIMED = {
      kind: 'claimed',
      tenantId: TENANT,
      approvalTextId: '0199f0a4-7c1e-7d2a-9b3c-4d5e6f7000aa',
      context: { tenantId: TENANT, userId: MESSAGE, role: 'owner' },
      proposalId: MESSAGE,
      fingerprint: 'f'.repeat(64),
    };
    const reply = async (text: string) => {
      core.handleInboundSms.mockResolvedValue({ keyword: null, reply: null });
      const body = form(inbound(text));
      const response = await post(path, body, signature(path, body)).expect(200);
      return /<Message>(.*)<\/Message>/.exec(response.text)?.[1]?.replace(/&apos;/g, "'") ?? null;
    };

    it('claims the code as a skip, then declines as its member what the text showed', async () => {
      core.claimApprovalText.mockResolvedValue(CLAIMED);
      expect(await reply('No 4821')).toBe(APPROVAL_REPLIES.skipped);
      expect(core.claimApprovalText).toHaveBeenCalledWith(
        {},
        { from: '+15552340001', code: '4821', receivedAt: NOW, decision: 'skip' },
        { codeKey: expect.any(Buffer) as Buffer },
      );
      expect(approvals.skip).toHaveBeenCalledWith(CLAIMED.context, MESSAGE, 'f'.repeat(64));
      // Never an approval, and nothing for Activity's "approved by text".
      expect(approvals.approve).not.toHaveBeenCalled();
      expect(core.recordTextApproval).not.toHaveBeenCalled();
    });

    it('leaves a changed or handled card, and never answers with a 500', async () => {
      core.claimApprovalText.mockResolvedValue(CLAIMED);
      for (const [error, words] of [
        [new ProposalChangedError(), APPROVAL_REPLIES.changedNotSkipped],
        [new ProposalNotPendingError('rejected'), APPROVAL_REPLIES.handled],
        [new ProposalNotPendingError('approved'), APPROVAL_REPLIES.handled],
        [new ProposalNotPendingError('expired'), APPROVAL_REPLIES.expired],
        [new ForbiddenError(), APPROVAL_REPLIES.miss],
        [new Error('connection reset'), APPROVAL_REPLIES.refused],
      ] as const) {
        approvals.skip.mockRejectedValueOnce(error);
        expect(await reply('N 4821')).toBe(words);
      }
    });

    it('follows the "Y" rules: a replay, a spoof, the miss limit and a STOP', async () => {
      core.claimApprovalText.mockResolvedValueOnce({ kind: 'used' });
      expect(await reply('N 4821')).toBe(APPROVAL_REPLIES.used);
      core.claimApprovalText.mockResolvedValueOnce({ kind: 'miss' });
      expect(await reply('n4821')).toBe(APPROVAL_REPLIES.miss);
      // Counted with the "Y" misses: the same limit and key as a "Y" from this number.
      core.claimApprovalText.mockResolvedValueOnce({ kind: 'miss' });
      expect(await reply('Y 4821')).toBe(APPROVAL_REPLIES.miss);
      const misses = (limits.hit.mock.calls as unknown as [{ name: string }, string][]).filter(
        ([limit]) => limit.name === 'sms-approval-miss',
      );
      expect(misses).toHaveLength(2);
      expect(misses[0]).toEqual(misses[1]);
      expect(misses[0]?.[0]).toMatchObject({ max: 5 });
      limits.spent.mockResolvedValueOnce(true);
      expect(await reply('N 4821')).toBe(APPROVAL_REPLIES.miss);
      expect(core.claimApprovalText).toHaveBeenCalledTimes(3);
      db.isSmsOptedOut.mockResolvedValue(true);
      expect(await reply('N 4821')).toBeNull();
      expect(await reply('No')).toBeNull();
      expect(approvals.skip).not.toHaveBeenCalled();
    });

    it('tells a member\'s bare "N" or "No" how to reply, and a client\'s nothing', async () => {
      expect(await reply('N')).toBe(APPROVAL_REPLIES.skipWithoutCode);
      expect(await reply('No')).toBe(APPROVAL_REPLIES.skipWithoutCode);
      db.isMemberPhone.mockResolvedValueOnce(false);
      expect(await reply('No')).toBeNull();
      expect(core.claimApprovalText).not.toHaveBeenCalled();
    });
  });

  it('refuses a missing, wrong or tampered signature, before anything is read', async () => {
    const body = form(inbound());
    for (const sig of [undefined, 'bm9wZQ==', signature(path, body, 'f'.repeat(32))]) {
      const response = await post(path, body, sig).expect(401);
      expect(ApiErrorSchema.parse(response.body).code).toBe('webhook_signature_invalid');
    }
    const tampered = form(inbound('START'));
    await post(path, tampered, signature(path, body)).expect(401);
    // Signed for another URL (the status route) doesn't count here.
    await post(path, body, signature('/v1/webhooks/sms/status', body)).expect(401);
    expect(core.handleInboundSms).not.toHaveBeenCalled();
  });

  it('refuses a signed text from another Twilio account, or without its fields', async () => {
    const other = form(inbound('STOP', { AccountSid: `AC${'c'.repeat(32)}` }));
    await post(path, other, signature(path, other)).expect(400);
    const bare = form({ Body: 'STOP' });
    await post(path, bare, signature(path, bare)).expect(400);
    expect(core.handleInboundSms).not.toHaveBeenCalled();
  });

  it('is 404 while SMS isn’t on with Twilio', async () => {
    const body = form(inbound());
    await request(off.getHttpServer() as Server)
      .post(path)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('X-Twilio-Signature', signature(path, body))
      .send(body)
      .expect(404);
  });
});

describe('POST /v1/webhooks/sms/status (AC-X-62)', () => {
  const path = `/v1/webhooks/sms/status?t=${TENANT}&m=${MESSAGE}`;
  const report = (extra: Record<string, string> = {}) =>
    form({
      MessageSid: `SM${'d'.repeat(32)}`,
      AccountSid: ACCOUNT,
      MessageStatus: 'undelivered',
      ErrorCode: '30003',
      ...extra,
    });

  it('records the report for the business and message the signed query names', async () => {
    const body = report();
    const response = await post(path, body, signature(path, body)).expect(200);
    expect(response.body).toEqual({ received: true });
    expect(core.recordSmsStatus).toHaveBeenCalledWith(
      {},
      {
        tenantId: TENANT,
        messageId: MESSAGE,
        providerMessageId: `SM${'d'.repeat(32)}`,
        status: 'undelivered',
        errorCode: 30003,
      },
    );
  });

  it('records a report with ErrorCode 0 as no error', async () => {
    const body = report({ MessageStatus: 'delivered', ErrorCode: '0' });
    await post(path, body, signature(path, body)).expect(200);
    expect(core.recordSmsStatus).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ errorCode: null }),
    );
  });

  it('refuses a query changed after signing, or one that names no business', async () => {
    const body = report();
    const otherTenant = `/v1/webhooks/sms/status?t=0199f4b2-7c1e-7a00-8000-0000000000ff&m=${MESSAGE}`;
    await post(otherTenant, body, signature(path, body)).expect(401);
    const noTenant = `/v1/webhooks/sms/status?m=${MESSAGE}`;
    await post(noTenant, body, signature(noTenant, body)).expect(400);
    const other = report({ AccountSid: `AC${'c'.repeat(32)}` });
    await post(path, other, signature(path, other)).expect(400);
    expect(core.recordSmsStatus).not.toHaveBeenCalled();
  });
});
