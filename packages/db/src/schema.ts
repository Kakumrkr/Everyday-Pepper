import { sql, type SQL } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  bigint,
  foreignKey,
  integer,
  smallint,
  jsonb,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { newId } from './ids.js';

// Source of truth for the tables. `pnpm --filter @floty/db generate` turns changes into a SQL
// migration; RLS hardening that drizzle-kit cannot express (FORCE, grants, triggers) goes in
// hand-written migrations (see migrations/ and docs/adr/0010-database-roles-and-migrations.md).
// Keep this file free of relative imports other than ./ids.js: drizzle-kit loads it directly.

/** Tenant of the current transaction, set by `withTenant`; NULL outside one. Defined in SQL. */
const currentTenantId = sql`current_tenant_id()`;
/** User of the current transaction, set by `withUser`; NULL outside one. Defined in SQL. */
const currentUserId = sql`current_user_id()`;

/** The one RLS policy every tenant-owned table has: rows of the current tenant only. */
function tenantIsolation(column: SQL): ReturnType<typeof pgPolicy> {
  const sameTenant = sql`${column} = ${currentTenantId}`;
  return pgPolicy('tenant_isolation', { for: 'all', using: sameTenant, withCheck: sameTenant });
}

/**
 * Read-only access for the "my businesses" lookup (`withUser`): a signed-in user sees their own
 * rows across tenants. Only applies when no tenant is set, so tenant transactions never see
 * another tenant's rows through it.
 */
function memberRead(using: SQL): ReturnType<typeof pgPolicy> {
  return pgPolicy('member_read', {
    for: 'select',
    using: sql`${currentTenantId} IS NULL AND ${using}`,
  });
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
  () => [
    tenantIsolation(sql.raw('id')),
    memberRead(sql`id IN (SELECT tenant_id FROM memberships WHERE user_id = ${currentUserId})`),
  ],
);

export const membershipRole = pgEnum('membership_role', ['owner', 'manager', 'staff']);

// Auth tables (Better Auth, ADR-0007 and ADR-0012). Global, not tenant-owned: a user signs in
// once and may belong to several businesses. Better Auth reads and writes them through
// `authDatabaseAdapter`; their TypeScript keys are its field names. No RLS: sign-in looks up
// users and sessions before any tenant or user is known.

/** A person who can sign in. Emails are stored lowercased (Better Auth normalises them). */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    name: text('name').notNull(),
    email: text('email').notNull().unique(),
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),
    twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
    ...timestamps,
  },
  (table) => [check('users_email_lowercase', sql`${table.email} = lower(${table.email})`)],
);

/** A signed-in browser. `token` is the cookie value; `active_tenant_id` is the chosen business. */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    token: text('token').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    // Set only by `setSessionActiveTenant` after a membership check, never by Better Auth input.
    activeTenantId: uuid('active_tenant_id').references(() => tenants.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (table) => [index('sessions_user_id_idx').on(table.userId)],
);

/** A way to sign in: the password hash for email sign-in, tokens for OAuth providers later. */
export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    password: text('password'),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    ...timestamps,
  },
  (table) => [index('accounts_user_id_idx').on(table.userId)],
);

/** Short-lived values Better Auth verifies later (e.g. email verification, from Phase 5). */
export const verifications = pgTable(
  'verifications',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [index('verifications_identifier_idx').on(table.identifier)],
);

/** A user's TOTP secret and backup codes, both encrypted by Better Auth with the auth secret. */
export const twoFactors = pgTable(
  'two_factors',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    secret: text('secret').notNull(),
    backupCodes: text('backup_codes').notNull(),
    verified: boolean('verified').notNull().default(true),
    failedVerificationCount: integer('failed_verification_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index('two_factors_user_id_idx').on(table.userId)],
);

/** A user's role in a tenant. */
export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    tenantId: uuid('tenant_id')
      .notNull()
      .default(currentTenantId)
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: membershipRole('role').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('memberships_tenant_user_unique').on(table.tenantId, table.userId),
    // Target of tenant-scoped foreign keys (staff_members.membership_id, ADR-0015).
    unique('memberships_tenant_id_id_unique').on(table.tenantId, table.id),
    // The unique index leads with tenant_id; "my businesses" looks memberships up by user.
    index('memberships_user_id_idx').on(table.userId),
    tenantIsolation(sql.raw('tenant_id')),
    memberRead(sql`user_id = ${currentUserId}`),
  ],
);

export const auditActorKind = pgEnum('audit_actor_kind', ['user', 'system']);

/**
 * What changed in a business, who changed it and when (ADR-0013). Append-only: the services
 * may insert and read rows but not update or delete them (grants in migration 0007). Entries
 * are written in the same transaction as the change and validated against `AuditChangeSchema`
 * (`@floty/contracts`), whose per-action schemas keep personal data out of `before`/`after`.
 * Ids are UUID v7, so `id` order is time order.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    tenantId: uuid('tenant_id')
      .notNull()
      .default(currentTenantId)
      .references(() => tenants.id, { onDelete: 'cascade' }),
    actorKind: auditActorKind('actor_kind').notNull(),
    // NULL for the system, and once the user's account is deleted (the entry stays).
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    // The `x-request-id` of the change, to find its log lines.
    requestId: text('request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'audit_log_system_has_no_user',
      sql`${table.actorKind} = 'user' OR ${table.actorUserId} IS NULL`,
    ),
    check('audit_log_request_id_length', sql`length(${table.requestId}) <= 128`),
    // Newest-first pages per tenant.
    index('audit_log_tenant_id_id_idx').on(table.tenantId, table.id),
    // Deleting a user nulls their entries' actor.
    index('audit_log_actor_user_id_idx').on(table.actorUserId),
    tenantIsolation(sql.raw('tenant_id')),
  ],
);

export const usageMetric = pgEnum('usage_metric', ['llm_tokens', 'emails_sent']);

/** How much of each metered thing a business used per UTC month (ADR-0013). */
export const usageMeters = pgTable(
  'usage_meters',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    tenantId: uuid('tenant_id')
      .notNull()
      .default(currentTenantId)
      .references(() => tenants.id, { onDelete: 'cascade' }),
    metric: usageMetric('metric').notNull(),
    // `YYYY-MM`, a calendar month in UTC.
    period: text('period').notNull(),
    amount: bigint('amount', { mode: 'number' }).notNull().default(0),
    ...timestamps,
  },
  (table) => [
    unique('usage_meters_tenant_metric_period_unique').on(
      table.tenantId,
      table.metric,
      table.period,
    ),
    check('usage_meters_period_format', sql`${table.period} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check('usage_meters_amount_not_negative', sql`${table.amount} >= 0`),
    tenantIsolation(sql.raw('tenant_id')),
  ],
);

/**
 * An invitation to join a business with a role (ADR-0014). Only the SHA-256 hash of the link's
 * token is stored. Open until accepted, revoked or past `expires_at`; at most one open invite
 * per email per business. The invitee is not a member yet, so the `invite_lookup` policy lets
 * a transaction without a tenant read the one invite whose token it presents
 * (`withInviteTenant`).
 */
export const invites = pgTable(
  'invites',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    tenantId: uuid('tenant_id')
      .notNull()
      .default(currentTenantId)
      .references(() => tenants.id, { onDelete: 'cascade' }),
    // Lowercased; acceptance requires the signed-in user's email to match.
    email: text('email').notNull(),
    role: membershipRole('role').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    invitedByUserId: uuid('invited_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedByUserId: uuid('accepted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    check('invites_email_lowercase', sql`${table.email} = lower(${table.email})`),
    check('invites_token_hash_format', sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'invites_accepted_or_revoked',
      sql`${table.acceptedAt} IS NULL OR ${table.revokedAt} IS NULL`,
    ),
    uniqueIndex('invites_open_email_unique')
      .on(table.tenantId, table.email)
      .where(sql`${table.acceptedAt} IS NULL AND ${table.revokedAt} IS NULL`),
    // Deleting a user nulls these.
    index('invites_invited_by_user_id_idx').on(table.invitedByUserId),
    index('invites_accepted_by_user_id_idx').on(table.acceptedByUserId),
    tenantIsolation(sql.raw('tenant_id')),
    pgPolicy('invite_lookup', {
      for: 'select',
      using: sql`${currentTenantId} IS NULL AND token_hash = current_invite_token_hash()`,
    }),
  ],
);

// Appointments base data (ADR-0015). Rows reference each other with composite foreign keys on
// (tenant_id, id): a foreign key check bypasses RLS, so a single-column reference could point
// at another business's row by its id. With the tenant in the key it cannot.

/** A service the business offers. Prices in cents; the name is unique per business. */
export const services = pgTable(
  'services',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    tenantId: uuid('tenant_id')
      .notNull()
      .default(currentTenantId)
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    category: text('category'),
    durationMinutes: integer('duration_minutes').notNull(),
    bufferBeforeMinutes: integer('buffer_before_minutes').notNull().default(0),
    bufferAfterMinutes: integer('buffer_after_minutes').notNull().default(0),
    priceFromCents: integer('price_from_cents'),
    priceToCents: integer('price_to_cents'),
    active: boolean('active').notNull().default(true),
    ...timestamps,
  },
  (table) => [
    unique('services_tenant_id_id_unique').on(table.tenantId, table.id),
    uniqueIndex('services_tenant_name_unique').on(table.tenantId, sql`lower(${table.name})`),
    check('services_name_length', sql`length(${table.name}) BETWEEN 1 AND 120`),
    check('services_category_length', sql`length(${table.category}) BETWEEN 1 AND 60`),
    check('services_duration_range', sql`${table.durationMinutes} BETWEEN 5 AND 720`),
    check(
      'services_buffers_range',
      sql`${table.bufferBeforeMinutes} BETWEEN 0 AND 240 AND ${table.bufferAfterMinutes} BETWEEN 0 AND 240`,
    ),
    check(
      'services_price_range',
      sql`${table.priceFromCents} BETWEEN 0 AND 10000000 AND ${table.priceToCents} BETWEEN 0 AND 10000000`,
    ),
    check(
      'services_price_to_after_from',
      sql`${table.priceToCents} IS NULL OR (${table.priceFromCents} IS NOT NULL AND ${table.priceToCents} > ${table.priceFromCents})`,
    ),
    tenantIsolation(sql.raw('tenant_id')),
  ],
);

/**
 * Someone who can be booked. `membership_id` links them to a member's app login (at most one
 * staff member per membership); removing the member unlinks them (migration 0012).
 */
export const staffMembers = pgTable(
  'staff_members',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    tenantId: uuid('tenant_id')
      .notNull()
      .default(currentTenantId)
      .references(() => tenants.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    color: text('color').notNull(),
    active: boolean('active').notNull().default(true),
    membershipId: uuid('membership_id'),
    ...timestamps,
  },
  (table) => [
    unique('staff_members_tenant_id_id_unique').on(table.tenantId, table.id),
    unique('staff_members_membership_id_unique').on(table.membershipId),
    check('staff_members_display_name_length', sql`length(${table.displayName}) BETWEEN 1 AND 80`),
    check('staff_members_color_format', sql`${table.color} ~ '^#[0-9a-f]{6}$'`),
    tenantIsolation(sql.raw('tenant_id')),
  ],
);

/** Which services a staff member offers. */
export const staffServices = pgTable(
  'staff_services',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    tenantId: uuid('tenant_id')
      .notNull()
      .default(currentTenantId)
      .references(() => tenants.id, { onDelete: 'cascade' }),
    staffMemberId: uuid('staff_member_id').notNull(),
    serviceId: uuid('service_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('staff_services_staff_service_unique').on(table.staffMemberId, table.serviceId),
    index('staff_services_tenant_service_idx').on(table.tenantId, table.serviceId),
    foreignKey({
      name: 'staff_services_staff_member_fk',
      columns: [table.tenantId, table.staffMemberId],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'staff_services_service_fk',
      columns: [table.tenantId, table.serviceId],
      foreignColumns: [services.tenantId, services.id],
    }).onDelete('cascade'),
    tenantIsolation(sql.raw('tenant_id')),
  ],
);

/**
 * A staff member's weekly working interval, in the business's local time: ISO weekday
 * (1 = Monday) and minutes after midnight. Intervals of one staff member and day never overlap
 * (exclusion constraint, migration 0012).
 */
export const workingHours = pgTable(
  'working_hours',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    tenantId: uuid('tenant_id')
      .notNull()
      .default(currentTenantId)
      .references(() => tenants.id, { onDelete: 'cascade' }),
    staffMemberId: uuid('staff_member_id').notNull(),
    weekday: smallint('weekday').notNull(),
    startMinute: smallint('start_minute').notNull(),
    endMinute: smallint('end_minute').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('working_hours_weekday_range', sql`${table.weekday} BETWEEN 1 AND 7`),
    check(
      'working_hours_minutes_range',
      sql`${table.startMinute} >= 0 AND ${table.endMinute} <= 1440 AND ${table.endMinute} > ${table.startMinute}`,
    ),
    foreignKey({
      name: 'working_hours_staff_member_fk',
      columns: [table.tenantId, table.staffMemberId],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }).onDelete('cascade'),
    tenantIsolation(sql.raw('tenant_id')),
  ],
);

/** A span when a staff member cannot be booked, in UTC. */
export const timeOff = pgTable(
  'time_off',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    tenantId: uuid('tenant_id')
      .notNull()
      .default(currentTenantId)
      .references(() => tenants.id, { onDelete: 'cascade' }),
    staffMemberId: uuid('staff_member_id').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    // Who entered it; NULL once their account is deleted.
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('time_off_ends_after_start', sql`${table.endsAt} > ${table.startsAt}`),
    check('time_off_max_length', sql`${table.endsAt} - ${table.startsAt} <= interval '366 days'`),
    index('time_off_staff_member_ends_at_idx').on(
      table.tenantId,
      table.staffMemberId,
      table.endsAt,
    ),
    index('time_off_created_by_user_id_idx').on(table.createdByUserId),
    foreignKey({
      name: 'time_off_staff_member_fk',
      columns: [table.tenantId, table.staffMemberId],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }).onDelete('cascade'),
    tenantIsolation(sql.raw('tenant_id')),
  ],
);

/**
 * A booking rule of a business (ADR-0016): its type, the schema version of its `params` (the
 * contracts' `RuleSchema` validates them when written and read), and the staff member it is
 * for (`NULL`: the whole business). At most one rule of each single-valued type per staff
 * member or business (partial unique index, migration 0014); blackout windows may repeat.
 */
export const bookingRules = pgTable(
  'booking_rules',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    tenantId: uuid('tenant_id')
      .notNull()
      .default(currentTenantId)
      .references(() => tenants.id, { onDelete: 'cascade' }),
    staffMemberId: uuid('staff_member_id'),
    type: text('type').notNull(),
    version: smallint('version').notNull(),
    params: jsonb('params').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'booking_rules_type_known',
      sql`${table.type} IN ('slot_interval', 'minimum_notice', 'maximum_advance', 'max_bookings_per_day', 'blackout_window')`,
    ),
    check('booking_rules_version_positive', sql`${table.version} >= 1`),
    check('booking_rules_params_object', sql`jsonb_typeof(${table.params}) = 'object'`),
    index('booking_rules_staff_member_idx').on(table.tenantId, table.staffMemberId),
    // A business-wide rule has no staff member; the key is then not checked (MATCH SIMPLE).
    foreignKey({
      name: 'booking_rules_staff_member_fk',
      columns: [table.tenantId, table.staffMemberId],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }).onDelete('cascade'),
    tenantIsolation(sql.raw('tenant_id')),
  ],
);

export type Tenant = typeof tenants.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type InviteRow = typeof invites.$inferSelect;
export type ServiceRow = typeof services.$inferSelect;
export type StaffMemberRow = typeof staffMembers.$inferSelect;
export type WorkingHoursRow = typeof workingHours.$inferSelect;
export type TimeOffRow = typeof timeOff.$inferSelect;
export type BookingRuleRow = typeof bookingRules.$inferSelect;
