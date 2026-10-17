import { describe, expect, it } from 'vitest';
import {
  BusinessLimitReachedError,
  isUniqueViolation,
  MembershipExistsError,
  TenantSlugTakenError,
} from './errors.js';

function pgError(code: string, constraint?: string): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code,
    constraint,
  });
}

describe('isUniqueViolation', () => {
  it('matches the driver error', () => {
    expect(isUniqueViolation(pgError('23505', 'tenants_slug_unique'), 'tenants_slug_unique')).toBe(
      true,
    );
  });

  it('matches a driver error wrapped as cause (drizzle)', () => {
    const wrapped = new Error('Failed query', { cause: pgError('23505', 'tenants_slug_unique') });
    expect(isUniqueViolation(wrapped, 'tenants_slug_unique')).toBe(true);
  });

  it.each([
    ['another constraint', pgError('23505', 'other_unique')],
    ['another error code', pgError('23503', 'tenants_slug_unique')],
    ['a plain error', new Error('boom')],
    ['a non-error', { code: '23505', constraint: 'tenants_slug_unique' }],
    ['undefined', undefined],
  ])('ignores %s', (_label, error) => {
    expect(isUniqueViolation(error, 'tenants_slug_unique')).toBe(false);
  });

  it('stops following causes after a few levels', () => {
    let error: Error = pgError('23505', 'tenants_slug_unique');
    for (let i = 0; i < 5; i++) error = new Error('wrapper', { cause: error });
    expect(isUniqueViolation(error, 'tenants_slug_unique')).toBe(false);
  });
});

describe('domain errors', () => {
  it('keep the cause and a safe message', () => {
    const cause = pgError('23505');
    const slug = new TenantSlugTakenError({ cause });
    expect(slug).toMatchObject({ name: 'TenantSlugTakenError', cause });
    expect(slug.message).toBe('This slug is already taken');
    expect(new MembershipExistsError()).toMatchObject({ name: 'MembershipExistsError' });
    expect(new BusinessLimitReachedError(5)).toMatchObject({
      name: 'BusinessLimitReachedError',
      limit: 5,
      message: 'A user may own at most 5 businesses',
    });
  });
});
