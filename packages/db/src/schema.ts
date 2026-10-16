import { sql, type SQL } from 'drizzle-orm';
import { pgEnum, pgPolicy, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { newId } from './ids.js';

// Source of truth for the tables. `pnpm --filter @floty/db generate` turns changes into a SQL
// migration; RLS hardening that drizzle-kit cannot express (FORCE, grants, triggers) goes in
// hand-written migrations (see migrations/ and docs/adr/0010-database-roles-and-migrations.md).
// Keep this file free of relative imports other than ./ids.js: drizzle-kit loads it directly.

/** Tenant of the current transaction, set by `withTenant`; NULL outside one. Defined in SQL. */
const currentTenantId = sql`current_tenant_id()`;

/** The one RLS policy every tenant-owned table has: rows of the current tenant only. */
function tenantIsolation(column: SQL): ReturnType<typeof pgPolicy> {
  const sameTenant = sql`${column} = ${currentTenantId}`;
  return pgPolicy('tenant_isolation', { for: 'all', using: sameTenant, withCheck: sameTenant });
}

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Kept current by the set_updated_at trigger.
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/** A business. Visible only to itself: `id` is the tenant id. */
export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    timeZone: text('time_zone').notNull(),
    locale: text('locale').notNull(),
    ...timestamps,
  },
  () => [tenantIsolation(sql.raw('id'))],
);

export const membershipRole = pgEnum('membership_role', ['owner', 'manager', 'staff']);

/** A user's role in a tenant. `user_id` gets its foreign key when users arrive with auth (S7). */
export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    tenantId: uuid('tenant_id')
      .notNull()
      .default(currentTenantId)
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    role: membershipRole('role').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('memberships_tenant_user_unique').on(table.tenantId, table.userId),
    tenantIsolation(sql.raw('tenant_id')),
  ],
);

export type Tenant = typeof tenants.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
