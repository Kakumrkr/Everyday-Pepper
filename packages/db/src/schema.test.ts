import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  accounts,
  aiActionExecutions,
  aiActionProposals,
  auditLog,
  autonomySettings,
  invites,
  memberships,
  memoryEpisodes,
  memoryFacts,
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

  it('keeps the trust layer with its tenant, and its receipts when a member is deleted (ADR-0028)', () => {
    expect(foreignKeys(autonomySettings)).toEqual([
      { from: ['tenant_id'], to: 'tenants(id)', onDelete: 'cascade' },
      { from: ['updated_by_user_id'], to: 'users(id)', onDelete: 'set null' },
    ]);
    expect(foreignKeys(aiActionProposals)).toEqual([
      { from: ['tenant_id'], to: 'tenants(id)', onDelete: 'cascade' },
      { from: ['requested_by_user_id'], to: 'users(id)', onDelete: 'set null' },
      { from: ['decided_by_user_id'], to: 'users(id)', onDelete: 'set null' },
    ]);
    expect(foreignKeys(aiActionExecutions)).toEqual([
      { from: ['tenant_id'], to: 'tenants(id)', onDelete: 'cascade' },
      { from: ['on_behalf_of_user_id'], to: 'users(id)', onDelete: 'set null' },
      // S26: whose request it answered.
      { from: ['requested_by_user_id'], to: 'users(id)', onDelete: 'set null' },
      { from: ['undone_by_user_id'], to: 'users(id)', onDelete: 'set null' },
      {
        from: ['tenant_id', 'proposal_id'],
        to: 'ai_action_proposals(tenant_id,id)',
        onDelete: 'no action',
      },
    ]);
  });
});

describe('memory (ADR-0034)', () => {
  it('goes with its business, subject or member; keeps facts of a deleted account', () => {
    expect(foreignKeys(memoryFacts)).toEqual(
      expect.arrayContaining([
        { from: ['tenant_id'], to: 'tenants(id)', onDelete: 'cascade' },
        { from: ['created_by_user_id'], to: 'users(id)', onDelete: 'set null' },
        { from: ['tenant_id', 'client_id'], to: 'clients(tenant_id,id)', onDelete: 'cascade' },
        {
          from: ['tenant_id', 'staff_member_id'],
          to: 'staff_members(tenant_id,id)',
          onDelete: 'cascade',
        },
        { from: ['tenant_id', 'service_id'], to: 'services(tenant_id,id)', onDelete: 'cascade' },
        { from: ['tenant_id', 'booking_id'], to: 'bookings(tenant_id,id)', onDelete: 'cascade' },
      ]),
    );
    expect(foreignKeys(memoryEpisodes)).toEqual(
      expect.arrayContaining([
        { from: ['tenant_id'], to: 'tenants(id)', onDelete: 'cascade' },
        {
          from: ['tenant_id', 'user_id'],
          to: 'memberships(tenant_id,user_id)',
          onDelete: 'cascade',
        },
      ]),
    );
  });

  it('declares one active value per subject and key, and the member-scope policies', () => {
    const facts = getTableConfig(memoryFacts);
    expect(facts.indexes.map((index) => index.config.name)).toContain('memory_facts_one_active');
    expect(facts.policies.map((policy) => policy.name).sort()).toEqual([
      'member_scope_delete',
      'member_scope_insert',
      'member_scope_read',
      'member_scope_update',
      'tenant_isolation',
    ]);
    expect(
      getTableConfig(memoryEpisodes)
        .policies.map((policy) => policy.name)
        .sort(),
    ).toEqual(['member_scope', 'tenant_isolation']);
  });
});
