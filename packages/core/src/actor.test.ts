import { TenantIdSchema, UserIdSchema } from '@floty/contracts';
import { describe, expect, it } from 'vitest';
import { requirePermission, type Actor } from './actor.js';
import { ForbiddenError, LastOwnerError, MemberNotFoundError } from './errors.js';

const tenantId = TenantIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192');
const me = UserIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193');
const other = UserIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708194');
const staff: Actor = { context: { tenantId, userId: me, role: 'staff' } };

describe('requirePermission', () => {
  it('passes when the matrix allows it', () => {
    expect(() => {
      requirePermission(staff, 'business.read');
    }).not.toThrow();
    expect(() => {
      requirePermission(staff, 'bookings.manage', { ownerUserId: me });
    }).not.toThrow();
  });

  it('throws ForbiddenError naming the permission otherwise', () => {
    expect(() => {
      requirePermission(staff, 'members.manage');
    }).toThrow(new ForbiddenError('members.manage'));
    expect(() => {
      requirePermission(staff, 'bookings.manage', { ownerUserId: other });
    }).toThrow(ForbiddenError);
  });
});

describe('domain errors', () => {
  it('have names and safe messages', () => {
    expect(new ForbiddenError('audit.read')).toMatchObject({
      name: 'ForbiddenError',
      permission: 'audit.read',
      message: 'Not allowed: audit.read',
    });
    expect(new ForbiddenError().message).toBe('Not allowed');
    expect(new MemberNotFoundError().name).toBe('MemberNotFoundError');
    expect(new LastOwnerError().name).toBe('LastOwnerError');
  });
});
