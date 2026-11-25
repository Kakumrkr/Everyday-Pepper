import { NO_CANCELLATION_FEES } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import { feeFields, feeFrom, policyFields, policyFrom, policyPreview } from './cancellation-policy';

// The cancellation-policy builder (S67.2, AC-X-130/131).

const open = { noticeHours: 24, feesOffered: true, stored: null };
const twenty = { kind: 'fixed', amountCents: 2000 } as const;

describe('one cost’s fields', () => {
  it('reads a stored cost back', () => {
    expect(feeFields(undefined)).toEqual({ kind: 'none', amount: '', percent: '' });
    expect(feeFields({ kind: 'fixed', amountCents: 1250 })).toMatchObject({ amount: '12.50' });
    expect(feeFields({ kind: 'percent', percent: 50 })).toMatchObject({ percent: '50' });
  });

  it('checks what is typed, in words', () => {
    const fixed = { kind: 'fixed', amount: '20', percent: '' } as const;
    expect(feeFrom(fixed)).toEqual({ ok: true, fee: twenty });
    expect(feeFrom({ ...fixed, amount: '$1,000' })).toEqual({
      ok: true,
      fee: { kind: 'fixed', amountCents: 100_000 },
    });
    expect(feeFrom({ ...fixed, amount: 'twenty' })).toEqual({
      ok: false,
      message: 'Enter the fee as an amount, e.g. 20 or 12.50.',
    });
    expect(feeFrom({ ...fixed, amount: '0.25' })).toMatchObject({ ok: false });
    expect(feeFrom({ ...fixed, amount: '100001' })).toMatchObject({ ok: false });
    const percent = { kind: 'percent', amount: '', percent: '50' } as const;
    expect(feeFrom(percent)).toEqual({ ok: true, fee: { kind: 'percent', percent: 50 } });
    for (const bad of ['', '0', '101', '2.5', '1e2', '0x32', '-5']) {
      expect(feeFrom({ ...percent, percent: bad })).toMatchObject({ ok: false });
    }
  });
});

describe('the policy to save', () => {
  it('is null when off, and the terms when on', () => {
    expect(policyFrom(policyFields(null), open)).toEqual({ ok: true, fees: null });
    const fields = { ...policyFields(null), on: true };
    expect(policyFrom(fields, open)).toEqual({ ok: true, fees: NO_CANCELLATION_FEES });
    expect(
      policyFrom({ ...fields, noShow: { kind: 'fixed', amount: '20', percent: '' } }, open),
    ).toEqual({ ok: true, fees: { lateCancel: { kind: 'none' }, noShow: twenty } });
  });

  it('names each cost to fix', () => {
    const fields = {
      on: true,
      lateCancel: { kind: 'fixed', amount: '', percent: '' },
      noShow: { kind: 'percent', amount: '', percent: '120' },
    } as const;
    expect(policyFrom(fields, open)).toEqual({
      ok: false,
      errors: {
        lateCancel: 'Enter the fee as an amount, e.g. 20 or 12.50.',
        noShow: 'Enter a whole percent from 1 to 100.',
      },
    });
  });

  it('drops the late cancel with a notice of 0', () => {
    const fields = policyFields({ lateCancel: twenty, noShow: twenty });
    expect(policyFrom(fields, { ...open, noticeHours: 0 })).toEqual({
      ok: true,
      fees: { lateCancel: { kind: 'none' }, noShow: twenty },
    });
  });

  it('keeps no fee where fees aren’t offered, even one stored before (review)', () => {
    const stored = { lateCancel: twenty, noShow: twenty };
    const options = { noticeHours: 24, feesOffered: false, stored };
    const fields = policyFields(stored);
    expect(policyFrom(fields, options)).toEqual({ ok: true, fees: NO_CANCELLATION_FEES });
    expect(policyPreview(fields, options)).toBe(
      'Please cancel or reschedule at least 24 hours before your visit.',
    );
  });
});

describe('the preview', () => {
  it('is the sentence clients read, leaving out a cost not yet right', () => {
    expect(policyPreview(policyFields(null), open)).toBeNull();
    const fields = policyFields({ lateCancel: twenty, noShow: { kind: 'none' } });
    expect(policyPreview(fields, open)).toBe(
      'Please cancel or reschedule at least 24 hours before your visit. Later cancels may be charged $20.',
    );
    expect(
      policyPreview({ ...fields, lateCancel: { kind: 'fixed', amount: 'x', percent: '' } }, open),
    ).toBe('Please cancel or reschedule at least 24 hours before your visit.');
  });
});
