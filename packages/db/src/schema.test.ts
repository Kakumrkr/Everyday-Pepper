import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  accounts,
  auditLog,
  invites,
  memberships,
  pushSubscriptions,
  sessions,
  tasks,
  tenants,
  twoFactors,
  usageMeters,
  users,
} from './schema.js';

function foreignKeys(table: PgTable) {
  return getTableConfig(table).foreignKeys.map((fk) => {
    const { columns, foreignTable, foreignColumns } = fk.reference();
    return {
      from: columns.map((c) => c.name),
      to: `${getTableConfig(foreignTable).name}(${foreignColumns.map((c) => c.name).join()})`,
      onDelete: fk.onDelete,
    };
  });
}

describe('schema foreign keys', () => {
  it('removes a user’s memberships, sessions, accounts and second factor with the user', () => {
    for (const table of [memberships, sessions, accounts, twoFactors]) {
      expect(foreignKeys(table)).toContainEqual({
        from: ['user_id'],
        to: 'users(id)',
        onDelete: 'cascade',
      });
    }
  });

  it('removes memberships with their tenant and clears it from sessions', () => {
    expect(foreignKeys(memberships)).toContainEqual({
      from: ['tenant_id'],
      to: 'tenants(id)',
      onDelete: 'cascade',
    });
    expect(foreignKeys(sessions)).toContainEqual({
      from: ['active_tenant_id'],
      to: 'tenants(id)',
      onDelete: 'set null',
    });
  });

  it('removes audit entries and usage with their tenant, and keeps entries of a deleted user', () => {
    for (const table of [auditLog, usageMeters]) {
      expect(foreignKeys(table)).toContainEqual({
        from: ['tenant_id'],
        to: 'tenants(id)',
        onDelete: 'cascade',
      });
    }
    expect(foreignKeys(auditLog)).toContainEqual({
      from: ['actor_user_id'],
      to: 'users(id)',
      onDelete: 'set null',
    });
  });

  it('keeps users and tenants free of outgoing references', () => {
    expect([foreignKeys(users), foreignKeys(tenants)]).toEqual([[], []]);
  });

  it('removes invites with their tenant and keeps them when the inviter or accepter is deleted', () => {
    expect(foreignKeys(invites)).toEqual(
      expect.arrayContaining([
        { from: ['tenant_id'], to: 'tenants(id)', onDelete: 'cascade' },
        { from: ['invited_by_user_id'], to: 'users(id)', onDelete: 'set null' },
        { from: ['accepted_by_user_id'], to: 'users(id)', onDelete: 'set null' },
      ]),
    );
  });

  it('removes tasks with their tenant and keeps them when their creator is deleted (ADR-0026)', () => {
    expect(foreignKeys(tasks)).toEqual(
      expect.arrayContaining([
        { from: ['tenant_id'], to: 'tenants(id)', onDelete: 'cascade' },
        { from: ['created_by_user_id'], to: 'users(id)', onDelete: 'set null' },
      ]),
    );
  });

  it('removes a device with its tenant or with the membership it belongs to', () => {
    expect(foreignKeys(pushSubscriptions)).toEqual([
      { from: ['tenant_id'], to: 'tenants(id)', onDelete: 'cascade' },
      { from: ['tenant_id', 'user_id'], to: 'memberships(tenant_id,user_id)', onDelete: 'cascade' },
    ]);
  });
});
