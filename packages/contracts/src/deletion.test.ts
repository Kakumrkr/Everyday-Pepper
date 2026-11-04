import { describe, expect, it } from 'vitest';
import {
  AccountDeletionRequestSchema,
  BusinessDeletionRequestSchema,
  confirmsBusinessName,
} from './deletion.js';

describe('confirmsBusinessName (S51.2, AC-W1-40)', () => {
  it('takes the same words, whatever the case, spacing or quotes', () => {
    expect(confirmsBusinessName('juniper hair  studio ', 'Juniper Hair Studio')).toBe(true);
    expect(confirmsBusinessName("Dee's Nails", 'Dee’s Nails')).toBe(true);
  });

  it('refuses another name, part of it, or nothing', () => {
    expect(confirmsBusinessName('Juniper', 'Juniper Hair Studio')).toBe(false);
    expect(confirmsBusinessName('Juniper Hair Studios', 'Juniper Hair Studio')).toBe(false);
    expect(confirmsBusinessName('   ', '   ')).toBe(false);
  });
});

describe('the deletion requests', () => {
  it('need a name or a password, and nothing else', () => {
    expect(BusinessDeletionRequestSchema.safeParse({ confirmName: '' }).success).toBe(false);
    expect(
      BusinessDeletionRequestSchema.safeParse({ confirmName: 'A', tenantId: 'x' }).success,
    ).toBe(false);
    expect(AccountDeletionRequestSchema.safeParse({ password: 'x'.repeat(129) }).success).toBe(
      false,
    );
    expect(AccountDeletionRequestSchema.parse({ password: 'secret' })).toEqual({
      password: 'secret',
    });
  });
});
