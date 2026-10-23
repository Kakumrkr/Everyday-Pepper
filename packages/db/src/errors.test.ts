import { describe, expect, it } from 'vitest';
import {
  BookingIdempotencyKeyTakenError,
  BookingOverlapError,
  BusinessLimitReachedError,
  ClientEmailTakenError,
  isExclusionViolation,
  isForeignKeyViolation,
  isPolicyViolation,
  isUniqueViolation,
  MembershipExistsError,
  MemorySubjectUnreachableError,
  ServiceNameTakenError,
  StaffMemberLinkTakenError,
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

describe('isExclusionViolation', () => {
  const constraint = 'booking_occupancy_no_overlap';

  it('matches the driver error, also wrapped', () => {
    expect(isExclusionViolation(pgError('23P01', constraint), constraint)).toBe(true);
    const wrapped = new Error('Failed query', { cause: pgError('23P01', constraint) });
    expect(isExclusionViolation(wrapped, constraint)).toBe(true);
  });

  it('ignores a unique violation and another constraint', () => {
    expect(isExclusionViolation(pgError('23505', constraint), constraint)).toBe(false);
    expect(isExclusionViolation(pgError('23P01', 'working_hours_no_overlap'), constraint)).toBe(
      false,
    );
  });
});

describe('isPolicyViolation and isForeignKeyViolation (memory subjects, ADR-0034)', () => {
  it('match a row-level security refusal and a missing key, also wrapped', () => {
    expect(isPolicyViolation(new Error('Failed query', { cause: pgError('42501') }))).toBe(true);
    expect(isPolicyViolation(pgError('23505'))).toBe(false);
    expect(isPolicyViolation('not an error')).toBe(false);
    const missing = pgError('23503', 'memory_facts_client_fk');
    expect(isForeignKeyViolation(missing, 'memory_facts_client_fk')).toBe(true);
    expect(isForeignKeyViolation(missing, 'memory_facts_booking_fk')).toBe(false);
  });

  it('name an unreachable subject safely', () => {
    expect(new MemorySubjectUnreachableError()).toMatchObject({
      name: 'MemorySubjectUnreachableError',
      message: 'No such subject to remember a fact about',
    });
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
    expect(new ServiceNameTakenError({ cause })).toMatchObject({
      name: 'ServiceNameTakenError',
      cause,
    });
    expect(new StaffMemberLinkTakenError({ cause })).toMatchObject({
      name: 'StaffMemberLinkTakenError',
      cause,
    });
    expect(new ClientEmailTakenError({ cause })).toMatchObject({
      name: 'ClientEmailTakenError',
      cause,
    });
    expect(new BookingOverlapError({ cause })).toMatchObject({
      name: 'BookingOverlapError',
      cause,
    });
    expect(new BookingIdempotencyKeyTakenError({ cause })).toMatchObject({
      name: 'BookingIdempotencyKeyTakenError',
      cause,
    });
  });
});
