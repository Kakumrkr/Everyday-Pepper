import { OfferTokenSchema } from '@pepper/contracts';
import type { TenantTx } from '@pepper/db';
import { describe, expect, it } from 'vitest';
import { offerTextNumber, queueWaitlistOfferText } from './waitlist-texts.js';

// What decides an offer by text before any read (S79, AC-X-224, AC-X-225); the reads are in
// the matcher's integration tests.

// Never touched: each case answers before reading.
const tx = {} as TenantTx;
const TENANT = { timeZone: 'America/New_York', reminderSettings: {}, slug: 'juniper' };
const DETAILS = {
  businessName: 'Juniper',
  slug: 'juniper',
  timeZone: 'America/New_York',
  serviceName: 'Haircut',
  staffName: null,
  startsAt: '2026-11-03T20:00:00.000Z',
  email: 'kim@example.test',
  clientName: 'Kim',
  policy: { sentence: null, note: null },
};

describe('offers by text', () => {
  it('never texts a regular’s offer (marketing needs its own opt-in)', async () => {
    expect(
      await queueWaitlistOfferText(
        tx,
        TENANT,
        {
          offer: {
            id: '0199f4b2-7c1e-7a00-8000-0000000000c1',
            source: 'regular',
            clientId: '0199f4b2-7c1e-7a00-8000-0000000000c2',
            expiresAt: new Date('2026-11-03T18:00:00.000Z'),
          },
          token: OfferTokenSchema.parse('a'.repeat(43)),
          details: DETAILS,
        },
        {
          texts: true,
          baseUrl: 'https://app.example.test',
          outboxKey: Buffer.alloc(32),
          now: new Date('2026-11-03T16:00:00.000Z'),
        },
      ),
    ).toEqual({ texted: false });
  });

  it('texts nothing with texts off, or when the text could go only after the offer closes', async () => {
    const client = '0199f4b2-7c1e-7a00-8000-0000000000c2';
    // 11:00 in New York, closing at 13:00, but the deployment sends no texts.
    const day = {
      closesAt: Date.parse('2026-11-03T18:00:00.000Z'),
      now: Date.parse('2026-11-03T16:00:00.000Z'),
    };
    expect(await offerTextNumber(tx, TENANT, client, day, {})).toBeNull();
    // The business turned texts off.
    expect(
      await offerTextNumber(tx, { ...TENANT, reminderSettings: { texts: false } }, client, day, {
        texts: true,
      }),
    ).toBeNull();
    // 23:00, closing at 01:00: the first minute it may go is 8:00.
    const night = {
      closesAt: Date.parse('2026-11-03T06:00:00.000Z'),
      now: Date.parse('2026-11-03T04:00:00.000Z'),
    };
    expect(await offerTextNumber(tx, TENANT, client, night, { texts: true })).toBeNull();
    // 07:50, closing at 08:10: 10 minutes after 8:00 is too little.
    const early = {
      closesAt: Date.parse('2026-11-03T13:10:00.000Z'),
      now: Date.parse('2026-11-03T12:50:00.000Z'),
    };
    expect(await offerTextNumber(tx, TENANT, client, early, { texts: true })).toBeNull();
  });
});
