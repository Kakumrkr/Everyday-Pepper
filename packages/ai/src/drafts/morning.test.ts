import { SlotUnavailableError } from '@pepper/appointments';
import { DraftRefusedError, NudgeNotSendableError } from '@pepper/core';
import { describe, expect, it } from 'vitest';
import { proposalFailureOf } from './morning.js';

describe('proposalFailureOf (S36b code review)', () => {
  it('counts what the domain refused as refused', () => {
    expect(proposalFailureOf(new SlotUnavailableError([]))).toBe('refused');
    expect(proposalFailureOf(new DraftRefusedError('sensitive'))).toBe('refused');
    expect(proposalFailureOf(new NudgeNotSendableError('opted_out'))).toBe('refused');
  });

  it('counts anything else (a bug, the database) as failed, so the worker reports it', () => {
    expect(proposalFailureOf(new TypeError('x is undefined'))).toBe('failed');
    expect(proposalFailureOf(new Error('connection terminated'))).toBe('failed');
  });
});
