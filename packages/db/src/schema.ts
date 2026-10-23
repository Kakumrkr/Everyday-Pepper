import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
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
  vector,
} from 'drizzle-orm/pg-core';
import type { TemplateId } from '@pepper/contracts';
import { newId } from './ids.js';

// Source of truth for the tables. `pnpm --filter @pepper/db generate` turns changes into a SQL
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
/**
 * Read-only access, across businesses, for one worker job's scan (`withJobScan`, ADR-0025):
 * only in a transaction without a tenant whose `app.job_scan` setting names `job`.
 */
function jobScan(job: 'reminders' | 'cleanup' | 'tasks'): ReturnType<typeof pgPolicy> {
  return pgPolicy('job_scan', {
    for: 'select',
    using: sql`${currentTenantId} IS NULL AND current_job_scan(${sql.raw(`'${job}'`)})`,
  });
}

function memberRead(using: SQL): ReturnType<typeof pgPolicy> {
  return pgPolicy('member_read', {
    for: 'select',
    using: sql`${currentTenantId} IS NULL AND ${using}`,
  });
}

/**
 * Restricts a table's rows to the records the current member may reach (ADR-0017): every row
 * for owners, managers and work without a user (jobs, the booking page); for staff, only rows
 * of the staff member linked to their login (AC-W9-1). Restrictive, so it narrows the
 * `tenant_isolation` policy and never widens it. The functions are defined in migration 0015;
 * the sub-selects make Postgres evaluate them once per statement, not once per row.
 */
const memberSeesAll = sql`(SELECT current_member_sees_all())`;

/**
 * Only owners, managers and work without a user may change the rows that decide what a member
 * reaches (roles, staff links), so the member scope holds even if a service check is missed
 * (S13 security review). Updates check the new row only: staff may still lock these rows
 * (`SELECT ... FOR UPDATE` needs the UPDATE policy's USING clause) but not change them.
 */
function changesNeedSeesAll(options: { canDelete?: SQL } = {}) {
  return [
    pgPolicy('member_scope_update', {
      as: 'restrictive',
      for: 'update',
      using: sql`true`,
      withCheck: memberSeesAll,
    }),
    pgPolicy('member_scope_delete', {
      as: 'restrictive',
      for: 'delete',
      using:
        options.canDelete === undefined
          ? memberSeesAll
          : sql`${memberSeesAll} OR ${options.canDelete}`,
    }),
  ];
}

/**
 * A memory fact a staff member reaches through its subject (ADR-0034): a client or visit they
 * reach (the clients' and bookings' own member scope applies inside the sub-selects), or their
 * own staff member.
 */
const memoryFactReachable = sql`((subject_type = 'client' AND client_id IN (SELECT id FROM clients)) OR (subject_type = 'booking' AND booking_id IN (SELECT id FROM bookings)) OR (subject_type = 'staff' AND staff_member_id IN (SELECT current_member_staff_ids())))`;

function ownStaffMember(column: SQL): SQL {
  return sql`${memberSeesAll} OR ${column} IN (SELECT current_member_staff_ids())`;
}

/** A Postgres `tstzrange`, as Postgres prints it (e.g. `["2026-10-20 14:00:00+00",...)`). */
const tstzrange = customType<{ data: string }>({
  dataType: () => 'tstzrange',
});

/** A Postgres `bytea`, as a Node `Buffer`. */
const bytea = customType<{ data: Buffer }>({
  dataType: () => 'bytea',
});

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
    // The industry template it started from (ADR-0018); NULL: none, platform defaults only.
    // Validated against the known templates by the contracts; the check keeps the shape.
    templateId: text('template_id').$type<TemplateId>(),
    // The booking page's color (PCR-001); NULL: Pepper's neutral default.
    brandColor: text('brand_color'),
    // Whether Pepper learns new things (Phase 7, ADR-0034); existing memory still helps.
    memoryPaused: boolean('memory_paused').notNull().default(false),
    ...timestamps,
  },
  (table) => [
    check('tenants_template_id_format', sql`${table.templateId} ~ '^[a-z][a-z0-9-]{0,62}$'`),
    check('tenants_brand_color_format', sql`${table.brandColor} ~ '^#[0-9a-f]{6}$'`),
    tenantIsolation(sql.raw('id')),
    memberRead(sql`id IN (SELECT tenant_id FROM memberships WHERE user_id = ${currentUserId})`),
    // The public booking page finds its business by the slug in its URL (ADR-0022), before any
    // tenant is known: read-only, one row, and only while no tenant is set.
    pgPolicy('public_lookup', {
      for: 'select',
      using: sql`${currentTenantId} IS NULL AND slug = current_public_slug()`,
    }),
    // The worker's daily clean-up lists the businesses (ADR-0025) and then cleans each one
    // under its own tenant: read-only, and only while no tenant is set.
    jobScan('cleanup'),
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
    // A member may leave (delete their own membership), not change roles. Inserts stay with the
    // services: a business's first owner and invitees are not members yet when they are added.
    ...changesNeedSeesAll({ canDelete: sql`user_id = ${currentUserId}` }),
  ],
);

export const auditActorKind = pgEnum('audit_actor_kind', ['user', 'system', 'ai_on_behalf_of']);

/**
 * What changed in a business, who changed it and when (ADR-0013). Append-only: the services
 * may insert and read rows but not update or delete them (grants in migration 0007). Entries
 * are written in the same transaction as the change and validated against `AuditChangeSchema`
 * (`@pepper/contracts`), whose per-action schemas keep personal data out of `before`/`after`.
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
    // The AI acts for a member (ADR-0028), so it has one too; NULL once their account is
    // deleted. Written without naming the new kind, which a migration's own transaction can't use.
    check(
      'audit_log_system_has_no_user',
      sql`${table.actorKind} <> 'system' OR ${table.actorUserId} IS NULL`,
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
    pgPolicy('member_scope_insert', {
      as: 'restrictive',
      for: 'insert',
      withCheck: memberSeesAll,
    }),
    ...changesNeedSeesAll(),
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

/**
 * A client of the business (ADR-0017): who bookings and waitlist entries are for. Personal
 * data: never logged or audited. Staff see only clients they have a booking or waitlist entry
 * with, plus, inside a transaction that names an exact email or phone
 * (`setTransactionClientContact`, ADR-0020), the clients with that contact. They cannot change
 * or delete any (policies `member_scope*`).
 */
export const clients = pgTable(
  'clients',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    tenantId: uuid('tenant_id')
      .notNull()
      .default(currentTenantId)
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    email: text('email'),
    phone: text('phone'),
    source: text('source').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('clients_tenant_id_id_unique').on(table.tenantId, table.id),
    // One client per email in a business (the booking page will find returning clients by it).
    uniqueIndex('clients_tenant_email_unique').on(table.tenantId, table.email),
    index('clients_tenant_name_idx').on(table.tenantId, sql`lower(${table.name})`),
    check('clients_name_length', sql`length(${table.name}) BETWEEN 1 AND 120`),
    check(
      'clients_email_format',
      sql`${table.email} = lower(${table.email}) AND length(${table.email}) BETWEEN 3 AND 254 AND ${table.email} LIKE '%_@_%'`,
    ),
    check('clients_phone_format', sql`${table.phone} ~ '^[+][1-9][0-9]{6,14}$'`),
    check('clients_source_known', sql`${table.source} IN ('team', 'ai', 'booking_page', 'import')`),
    tenantIsolation(sql.raw('tenant_id')),
    pgPolicy('member_scope', {
      as: 'restrictive',
      for: 'all',
      using: sql`${memberSeesAll} OR id IN (SELECT client_id FROM bookings) OR id IN (SELECT client_id FROM waitlist_entries) OR (SELECT current_client_contact()) IN (email, phone)`,
      withCheck: memberSeesAll,
    }),
    // FOR ALL's USING lets a row be deleted that may be read; staff may read, not delete.
    pgPolicy('member_scope_delete', { as: 'restrictive', for: 'delete', using: memberSeesAll }),
  ],
);

/**
 * A booking (ADR-0017): a client's appointment for a service with a staff member, with a copy
 * of the service's duration (`ends_at`), buffers and price when it was made. Its occupied time
 * is kept in `booking_occupancy` by a trigger (migration 0017), which also holds the exclusion
 * constraint against double booking. Staff reach only their own staff member's bookings.
 */
export const bookings = pgTable(
  'bookings',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    tenantId: uuid('tenant_id')
      .notNull()
      .default(currentTenantId)
      .references(() => tenants.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id').notNull(),
    serviceId: uuid('service_id').notNull(),
    staffMemberId: uuid('staff_member_id').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    bufferBeforeMinutes: integer('buffer_before_minutes').notNull(),
    bufferAfterMinutes: integer('buffer_after_minutes').notNull(),
    priceFromCents: integer('price_from_cents'),
    priceToCents: integer('price_to_cents'),
    status: text('status').notNull().default('confirmed'),
    source: text('source').notNull(),
    overridden: boolean('overridden').notNull().default(false),
    idempotencyKey: text('idempotency_key'),
    // SHA-256 of the client's reschedule/cancel link token (ADR-0022); booking page only.
    manageTokenHash: text('manage_token_hash'),
    // Who made it; NULL for the booking page and once their account is deleted.
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (table) => [
    unique('bookings_tenant_id_id_unique').on(table.tenantId, table.id),
    uniqueIndex('bookings_tenant_idempotency_key_unique').on(table.tenantId, table.idempotencyKey),
    index('bookings_staff_member_starts_at_idx').on(
      table.tenantId,
      table.staffMemberId,
      table.startsAt,
    ),
    index('bookings_tenant_starts_at_idx').on(table.tenantId, table.startsAt),
    index('bookings_client_idx').on(table.tenantId, table.clientId),
    index('bookings_service_idx').on(table.tenantId, table.serviceId),
    index('bookings_created_by_user_id_idx').on(table.createdByUserId),
    check(
      'bookings_duration_range',
      sql`${table.endsAt} - ${table.startsAt} BETWEEN interval '5 minutes' AND interval '720 minutes'`,
    ),
    check(
      'bookings_buffers_range',
      sql`${table.bufferBeforeMinutes} BETWEEN 0 AND 240 AND ${table.bufferAfterMinutes} BETWEEN 0 AND 240`,
    ),
    check(
      'bookings_price_range',
      sql`${table.priceFromCents} BETWEEN 0 AND 10000000 AND ${table.priceToCents} BETWEEN 0 AND 10000000`,
    ),
    check(
      'bookings_status_known',
      sql`${table.status} IN ('confirmed', 'completed', 'no_show', 'cancelled')`,
    ),
    check('bookings_source_known', sql`${table.source} IN ('team', 'ai', 'booking_page')`),
    check(
      'bookings_idempotency_key_format',
      sql`${table.idempotencyKey} ~ '^[A-Za-z0-9_-]{8,100}$'`,
    ),
    uniqueIndex('bookings_manage_token_hash_unique').on(table.manageTokenHash),
    check('bookings_manage_token_hash_format', sql`${table.manageTokenHash} ~ '^[0-9a-f]{64}$'`),
    foreignKey({
      name: 'bookings_client_fk',
      columns: [table.tenantId, table.clientId],
      foreignColumns: [clients.tenantId, clients.id],
    }),
    foreignKey({
      name: 'bookings_service_fk',
      columns: [table.tenantId, table.serviceId],
      foreignColumns: [services.tenantId, services.id],
    }),
    foreignKey({
      name: 'bookings_staff_member_fk',
      columns: [table.tenantId, table.staffMemberId],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    tenantIsolation(sql.raw('tenant_id')),
    pgPolicy('member_scope', {
      as: 'restrictive',
      for: 'all',
      using: ownStaffMember(sql.raw('staff_member_id')),
      withCheck: ownStaffMember(sql.raw('staff_member_id')),
    }),
  ],
);

/**
 * The time each active (not cancelled) booking occupies: the appointment and its buffers, in
 * `occupied`. Written only by the `bookings` trigger (migration 0017); `id` is the booking's.
 * Everyone in the business may read it (the team calendar's busy times carry no booking
 * details); staff may write only their own staff member's rows. The exclusion constraint
 * `booking_occupancy_no_overlap` (migration 0017) is what makes double booking impossible.
 */
export const bookingOccupancy = pgTable(
  'booking_occupancy',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .default(currentTenantId)
      .references(() => tenants.id, { onDelete: 'cascade' }),
    staffMemberId: uuid('staff_member_id').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    occupied: tstzrange('occupied').notNull(),
  },
  (table) => [
    foreignKey({
      name: 'booking_occupancy_booking_fk',
      columns: [table.tenantId, table.id],
      foreignColumns: [bookings.tenantId, bookings.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'booking_occupancy_staff_member_fk',
      columns: [table.tenantId, table.staffMemberId],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    check(
      'booking_occupancy_covers_booking',
      sql`lower(${table.occupied}) <= ${table.startsAt} AND ${table.endsAt} <= upper(${table.occupied}) AND ${table.endsAt} > ${table.startsAt}`,
    ),
    tenantIsolation(sql.raw('tenant_id')),
    pgPolicy('member_scope_insert', {
      as: 'restrictive',
      for: 'insert',
      withCheck: ownStaffMember(sql.raw('staff_member_id')),
    }),
    pgPolicy('member_scope_update', {
      as: 'restrictive',
      for: 'update',
      using: ownStaffMember(sql.raw('staff_member_id')),
      withCheck: ownStaffMember(sql.raw('staff_member_id')),
    }),
    pgPolicy('member_scope_delete', {
      as: 'restrictive',
      for: 'delete',
      using: ownStaffMember(sql.raw('staff_member_id')),
    }),
  ],
);

/**
 * A client waiting for a service at times that are full (ADR-0017): local-time `windows`
 * (validated by the contracts' `WaitlistWindowSchema`), optionally with one staff member, until
 * `expires_at` (the end of the last window). `booking_id` is set when an offer is taken
 * (Phase 8). Staff reach only entries for their own staff member.
 */
export const waitlistEntries = pgTable(
  'waitlist_entries',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    tenantId: uuid('tenant_id')
      .notNull()
      .default(currentTenantId)
      .references(() => tenants.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id').notNull(),
    serviceId: uuid('service_id').notNull(),
    staffMemberId: uuid('staff_member_id'),
    windows: jsonb('windows').notNull(),
    status: text('status').notNull().default('waiting'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    bookingId: uuid('booking_id'),
    // Who added it; NULL once their account is deleted.
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (table) => [
    index('waitlist_entries_open_idx')
      .on(table.tenantId, table.createdAt)
      .where(sql`${table.status} IN ('waiting', 'offered')`),
    index('waitlist_entries_client_idx').on(table.tenantId, table.clientId),
    index('waitlist_entries_service_idx').on(table.tenantId, table.serviceId),
    index('waitlist_entries_staff_member_idx').on(table.tenantId, table.staffMemberId),
    index('waitlist_entries_booking_idx').on(table.tenantId, table.bookingId),
    index('waitlist_entries_created_by_user_id_idx').on(table.createdByUserId),
    check(
      'waitlist_entries_status_known',
      sql`${table.status} IN ('waiting', 'offered', 'booked', 'cancelled')`,
    ),
    check(
      'waitlist_entries_booked_has_booking',
      sql`(${table.status} = 'booked') = (${table.bookingId} IS NOT NULL)`,
    ),
    check(
      'waitlist_entries_windows_array',
      sql`jsonb_typeof(${table.windows}) = 'array' AND jsonb_array_length(${table.windows}) BETWEEN 1 AND 10`,
    ),
    foreignKey({
      name: 'waitlist_entries_client_fk',
      columns: [table.tenantId, table.clientId],
      foreignColumns: [clients.tenantId, clients.id],
    }),
    foreignKey({
      name: 'waitlist_entries_service_fk',
      columns: [table.tenantId, table.serviceId],
      foreignColumns: [services.tenantId, services.id],
    }),
    // Without a staff member (anyone) or a booking the key is not checked (MATCH SIMPLE).
    foreignKey({
      name: 'waitlist_entries_staff_member_fk',
      columns: [table.tenantId, table.staffMemberId],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    foreignKey({
      name: 'waitlist_entries_booking_fk',
      columns: [table.tenantId, table.bookingId],
      foreignColumns: [bookings.tenantId, bookings.id],
    }),
    tenantIsolation(sql.raw('tenant_id')),
    pgPolicy('member_scope', {
      as: 'restrictive',
      for: 'all',
      using: ownStaffMember(sql.raw('staff_member_id')),
      withCheck: ownStaffMember(sql.raw('staff_member_id')),
    }),
  ],
);

/**
 * A booking the public booking page was asked for, waiting for the client to type the code
 * emailed to them (ADR-0022, AC-W8-2). Nothing is booked before that: the time is checked
 * again when the code is confirmed. Only the code's keyed hash is stored; attempts are capped.
 * No member reads these (only work without a user, i.e. the booking page itself).
 */
export const bookingVerifications = pgTable(
  'booking_verifications',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    tenantId: uuid('tenant_id')
      .notNull()
      .default(currentTenantId)
      .references(() => tenants.id, { onDelete: 'cascade' }),
    serviceId: uuid('service_id').notNull(),
    // NULL: anyone who offers the service.
    staffMemberId: uuid('staff_member_id'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    phone: text('phone'),
    codeHash: text('code_hash').notNull(),
    attempts: smallint('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    bookingId: uuid('booking_id'),
    ...timestamps,
  },
  (table) => [
    index('booking_verifications_email_idx').on(table.tenantId, table.email, table.expiresAt),
    index('booking_verifications_service_idx').on(table.tenantId, table.serviceId),
    index('booking_verifications_staff_member_idx').on(table.tenantId, table.staffMemberId),
    index('booking_verifications_booking_idx').on(table.tenantId, table.bookingId),
    check('booking_verifications_name_length', sql`length(${table.name}) BETWEEN 1 AND 120`),
    check(
      'booking_verifications_email_format',
      sql`${table.email} = lower(${table.email}) AND length(${table.email}) BETWEEN 3 AND 254 AND ${table.email} LIKE '%_@_%'`,
    ),
    check('booking_verifications_phone_format', sql`${table.phone} ~ '^[+][1-9][0-9]{6,14}$'`),
    check('booking_verifications_code_hash_format', sql`${table.codeHash} ~ '^[0-9a-f]{64}$'`),
    check('booking_verifications_attempts_range', sql`${table.attempts} BETWEEN 0 AND 100`),
    foreignKey({
      name: 'booking_verifications_service_fk',
      columns: [table.tenantId, table.serviceId],
      foreignColumns: [services.tenantId, services.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'booking_verifications_staff_member_fk',
      columns: [table.tenantId, table.staffMemberId],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'booking_verifications_booking_fk',
      columns: [table.tenantId, table.bookingId],
      foreignColumns: [bookings.tenantId, bookings.id],
    }),
    tenantIsolation(sql.raw('tenant_id')),
    // Members never reach them; only work without a user (the booking page) does.
    pgPolicy('member_scope', {
      as: 'restrictive',
      for: 'all',
      using: sql`current_user_id() IS NULL`,
      withCheck: sql`current_user_id() IS NULL`,
    }),
  ],
);

export const outboxMessageType = pgEnum('outbox_message_type', ['email', 'push', 'episode']);
export const outboxStatus = pgEnum('outbox_status', ['pending', 'sent', 'dead', 'cancelled']);

/**
 * A side effect waiting to happen, written in the same transaction as the business change
 * (the transactional outbox, ADR-0003, ADR-0024). The worker claims it for a lease, delivers
 * it, and marks it sent; a failure retries at `available_at`, and after the last attempt it is
 * `dead`. The content is encrypted by the caller (it may carry a client's private link) and
 * cleared once the message is sent or dead. The dedupe key keeps a retried change from
 * queueing the same message twice.
 */
export const outboxMessages = pgTable(
  'outbox_messages',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    tenantId: uuid('tenant_id')
      .notNull()
      .default(currentTenantId)
      .references(() => tenants.id, { onDelete: 'cascade' }),
    type: outboxMessageType('type').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    // NULL once sent or dead.
    payload: bytea('payload'),
    status: outboxStatus('status').notNull().default('pending'),
    attempts: smallint('attempts').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    // While set and in the future, a worker is delivering the message.
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    // The last failure's error name (never its message, which may echo an address).
    lastError: text('last_error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique('outbox_messages_tenant_id_unique').on(table.tenantId, table.id),
    unique('outbox_messages_dedupe_key_unique').on(table.tenantId, table.dedupeKey),
    check(
      'outbox_messages_dedupe_key_format',
      sql`${table.dedupeKey} ~ '^[A-Za-z0-9.:_-]{1,200}$'`,
    ),
    check('outbox_messages_attempts_range', sql`${table.attempts} BETWEEN 0 AND 100`),
    check(
      'outbox_messages_last_error_format',
      sql`${table.lastError} ~ '^[A-Za-z0-9.:_-]{1,100}$'`,
    ),
    check(
      'outbox_messages_payload_while_pending',
      sql`(${table.status} = 'pending') = (${table.payload} IS NOT NULL)`,
    ),
    check(
      'outbox_messages_sent_at_when_sent',
      sql`(${table.status} = 'sent') = (${table.sentAt} IS NOT NULL)`,
    ),
    tenantIsolation(sql.raw('tenant_id')),
  ],
);

/**
 * The worker's index of pending outbox messages (ADR-0024): ids and due times only, no
 * content. A row exists while its message is pending. Tenant transactions reach their own rows;
 * the read-only `outbox_scan` policy lets the worker's relay (`withOutboxScan`, no tenant) read
 * every row, so it finds work across businesses and then handles each message under its
 * business's tenant context.
 */
export const outboxDispatch = pgTable(
  'outbox_dispatch',
  {
    // The message's id.
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull().default(currentTenantId),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('outbox_dispatch_available_at_idx').on(table.availableAt),
    foreignKey({
      name: 'outbox_dispatch_message_fk',
      columns: [table.tenantId, table.id],
      foreignColumns: [outboxMessages.tenantId, outboxMessages.id],
    }).onDelete('cascade'),
    tenantIsolation(sql.raw('tenant_id')),
    pgPolicy('outbox_scan', {
      for: 'select',
      using: sql`${currentTenantId} IS NULL AND current_outbox_scan()`,
    }),
  ],
);

/**
 * The reminder email planned for a confirmed booking (W6, ADR-0025): one row per booking while
 * its reminder is still to be sent, with the booking's id, when the reminder is due and the
 * start it was planned for. The booking services keep it in step in the booking's own
 * transaction (planned, moved, removed on cancel); the worker's reminder job finds due rows
 * across businesses (`job_scan`, ids and times only) and, under each business's tenant, checks
 * the booking again before it queues the email and removes the row.
 */
export const bookingReminders = pgTable(
  'booking_reminders',
  {
    // The booking's id.
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull().default(currentTenantId),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('booking_reminders_due_at_idx').on(table.dueAt),
    check('booking_reminders_due_before_start', sql`${table.dueAt} < ${table.startsAt}`),
    foreignKey({
      name: 'booking_reminders_booking_fk',
      columns: [table.tenantId, table.id],
      foreignColumns: [bookings.tenantId, bookings.id],
    }).onDelete('cascade'),
    tenantIsolation(sql.raw('tenant_id')),
    jobScan('reminders'),
  ],
);

/**
 * A to-do of the business's owners and staff (ADR-0026). Owners, managers and work without a
 * user reach every task; staff only those assigned to them or that they created (policy
 * `member_scope`). The assignee is a member of the business: the composite key to memberships
 * (migration 0031) clears it when they leave. `due_notified_at` is set once the assignee was
 * notified that it is due; a new due time clears it.
 */
export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    tenantId: uuid('tenant_id')
      .notNull()
      .default(currentTenantId)
      .references(() => tenants.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }),
    assigneeUserId: uuid('assignee_user_id'),
    status: text('status').notNull().default('open'),
    source: text('source').notNull().default('manual'),
    // Who added it; NULL for the platform's or once their account is deleted.
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    dueNotifiedAt: timestamp('due_notified_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique('tasks_tenant_id_id_unique').on(table.tenantId, table.id),
    index('tasks_open_idx')
      .on(table.tenantId, table.dueAt)
      .where(sql`${table.status} = 'open'`),
    index('tasks_assignee_idx').on(table.tenantId, table.assigneeUserId),
    index('tasks_created_by_user_id_idx').on(table.createdByUserId),
    // The due-task job's scan: open tasks with a due time not yet notified.
    index('tasks_due_scan_idx')
      .on(table.dueAt)
      .where(
        sql`${table.status} = 'open' AND ${table.dueAt} IS NOT NULL AND ${table.dueNotifiedAt} IS NULL`,
      ),
    check('tasks_title_length', sql`length(${table.title}) BETWEEN 1 AND 200`),
    check('tasks_status_known', sql`${table.status} IN ('open', 'done')`),
    check('tasks_source_known', sql`${table.source} IN ('manual', 'ai', 'system')`),
    check(
      'tasks_completed_when_done',
      sql`(${table.status} = 'done') = (${table.completedAt} IS NOT NULL)`,
    ),
    tenantIsolation(sql.raw('tenant_id')),
    pgPolicy('member_scope', {
      as: 'restrictive',
      for: 'all',
      using: sql`${memberSeesAll} OR assignee_user_id = ${currentUserId} OR created_by_user_id = ${currentUserId}`,
      withCheck: sql`${memberSeesAll} OR assignee_user_id = ${currentUserId} OR created_by_user_id = ${currentUserId}`,
    }),
    jobScan('tasks'),
  ],
);

/**
 * A device a member turned notifications on for, in one business (Web Push, ADR-0026): the
 * push service's endpoint and the browser's keys that encrypt each message to it. Each member
 * reaches only their own devices; work without a user (the worker sending a push, the booking
 * page queueing one) reaches all of the business's. Removed with the membership, or when the push service says the endpoint is gone.
 */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    tenantId: uuid('tenant_id')
      .notNull()
      .default(currentTenantId)
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('push_subscriptions_endpoint_unique').on(table.tenantId, table.endpoint),
    index('push_subscriptions_user_idx').on(table.tenantId, table.userId),
    foreignKey({
      name: 'push_subscriptions_membership_fk',
      columns: [table.tenantId, table.userId],
      foreignColumns: [memberships.tenantId, memberships.userId],
    }).onDelete('cascade'),
    check(
      'push_subscriptions_endpoint_format',
      sql`${table.endpoint} ~ '^https://' AND length(${table.endpoint}) <= 1000`,
    ),
    check('push_subscriptions_p256dh_format', sql`${table.p256dh} ~ '^[A-Za-z0-9_-]{80,100}$'`),
    check('push_subscriptions_auth_format', sql`${table.auth} ~ '^[A-Za-z0-9_-]{16,32}$'`),
    tenantIsolation(sql.raw('tenant_id')),
    pgPolicy('member_scope', {
      as: 'restrictive',
      for: 'all',
      using: sql`${currentUserId} IS NULL OR user_id = ${currentUserId}`,
      withCheck: sql`${currentUserId} IS NULL OR user_id = ${currentUserId}`,
    }),
  ],
);

// The trust layer (ADR-0028): a business's autonomy choices, the AI's proposals waiting for a
// member, and the actions it executed with their undo. Payloads, previews, before/after,
// inverses and explanations hold ids, times and codes only (`TrustJsonSchema` in the
// contracts); the size checks below back that up. Staff reach only their own proposals and
// executions; owners and managers reach all. The services may not delete either (receipts);
// once written, only a record's status fields may change (triggers in migration 0034).

/** The eleven actions on the dial, for the checks (`AutonomyActionSchema`). */
const autonomyActionList = sql.raw(
  "'booking.create', 'booking.move', 'booking.cancel', 'booking_request.accept', 'time.block', " +
    "'client_note.save', 'task.create', 'message.confirmation', 'message.rebooking_nudge', " +
    "'message.waitlist_offer', 'message.bulk'",
);
const trustCode = (column: SQLWrapper) => sql`${column} ~ '^[a-z][a-z0-9_.:-]{0,63}$'`;
const trustJsonSize = (column: SQLWrapper) => sql`octet_length(${column}::text) <= 8192`;

/**
 * A business's own autonomy choices (one row, or none: every action at its template's or the
 * platform's default). `levels` holds only the actions it changed. Everyone in the business
 * reads it (the AI decides with it for staff too); only owners and managers change it.
 */
export const autonomySettings = pgTable(
  'autonomy_settings',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    tenantId: uuid('tenant_id')
      .notNull()
      .default(currentTenantId)
      .references(() => tenants.id, { onDelete: 'cascade' }),
    askFirst: boolean('ask_first').notNull().default(false),
    levels: jsonb('levels')
      .notNull()
      .default(sql`'{}'::jsonb`),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (table) => [
    unique('autonomy_settings_tenant_unique').on(table.tenantId),
    index('autonomy_settings_updated_by_user_id_idx').on(table.updatedByUserId),
    check(
      'autonomy_settings_levels_known',
      sql`jsonb_typeof(${table.levels}) = 'object' AND ${table.levels} - ARRAY[${autonomyActionList}] = '{}'::jsonb AND NOT jsonb_path_exists(${table.levels}, '$.* ? (@ != "ask" && @ != "notify" && @ != "auto")')`,
    ),
    // "Just do it" is never allowed for one message to many clients (AC-W7-3).
    check(
      'autonomy_settings_bulk_never_auto',
      sql`${table.levels}->>'message.bulk' IS DISTINCT FROM 'auto'`,
    ),
    tenantIsolation(sql.raw('tenant_id')),
    pgPolicy('member_scope_insert', {
      as: 'restrictive',
      for: 'insert',
      withCheck: memberSeesAll,
    }),
    ...changesNeedSeesAll(),
  ],
);

/**
 * A write the AI proposed and a member must approve (ADR-0028): the exact payload, the
 * preview the member was shown and the fingerprint of the state it was computed on. At most
 * one proposal per target is pending; a retried tool call finds its proposal by its key.
 */
export const aiActionProposals = pgTable(
  'ai_action_proposals',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    tenantId: uuid('tenant_id')
      .notNull()
      .default(currentTenantId)
      .references(() => tenants.id, { onDelete: 'cascade' }),
    action: text('action').notNull(),
    tool: text('tool').notNull(),
    // The tool's version when proposed (S26): a proposal from an older version expires.
    toolVersion: integer('tool_version').notNull().default(1),
    targetKey: text('target_key').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status').notNull().default('pending'),
    payload: jsonb('payload').notNull(),
    preview: jsonb('preview').notNull(),
    fingerprint: text('fingerprint').notNull(),
    explanation: jsonb('explanation').notNull(),
    // The member whose request it answers; NULL once their account is deleted.
    requestedByUserId: uuid('requested_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    // The member whose record it changes (a staff member's booking), for the approver's check.
    recordOwnerUserId: uuid('record_owner_user_id'),
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    unique('ai_action_proposals_tenant_id_id_unique').on(table.tenantId, table.id),
    unique('ai_action_proposals_idempotency_key_unique').on(table.tenantId, table.idempotencyKey),
    uniqueIndex('ai_action_proposals_one_pending_per_target')
      .on(table.tenantId, table.targetKey)
      .where(sql`${table.status} = 'pending'`),
    index('ai_action_proposals_requested_by_idx').on(table.tenantId, table.requestedByUserId),
    index('ai_action_proposals_requested_by_user_id_idx').on(table.requestedByUserId),
    index('ai_action_proposals_decided_by_user_id_idx').on(table.decidedByUserId),
    index('ai_action_proposals_pending_expiry_idx')
      .on(table.expiresAt)
      .where(sql`${table.status} = 'pending'`),
    check('ai_action_proposals_action_known', sql`${table.action} IN (${autonomyActionList})`),
    check('ai_action_proposals_tool_format', trustCode(table.tool)),
    check('ai_action_proposals_tool_version_positive', sql`${table.toolVersion} >= 1`),
    check(
      'ai_action_proposals_target_key_format',
      sql`${table.targetKey} ~ '^[A-Za-z0-9.:_-]{1,200}$'`,
    ),
    check(
      'ai_action_proposals_idempotency_key_format',
      sql`${table.idempotencyKey} ~ '^[A-Za-z0-9.:_-]{8,200}$'`,
    ),
    check(
      'ai_action_proposals_status_known',
      sql`${table.status} IN ('pending', 'approved', 'rejected', 'expired', 'superseded')`,
    ),
    check('ai_action_proposals_fingerprint_format', sql`${table.fingerprint} ~ '^[0-9a-f]{64}$'`),
    check(
      'ai_action_proposals_decided_when_not_pending',
      sql`(${table.status} = 'pending') = (${table.decidedAt} IS NULL)`,
    ),
    check(
      'ai_action_proposals_expires_after_created',
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check('ai_action_proposals_payload_size', trustJsonSize(table.payload)),
    check('ai_action_proposals_preview_size', trustJsonSize(table.preview)),
    check('ai_action_proposals_explanation_size', trustJsonSize(table.explanation)),
    tenantIsolation(sql.raw('tenant_id')),
    pgPolicy('member_scope', {
      as: 'restrictive',
      for: 'all',
      using: sql`${memberSeesAll} OR requested_by_user_id = ${currentUserId}`,
      withCheck: sql`${memberSeesAll} OR requested_by_user_id = ${currentUserId}`,
    }),
  ],
);

/**
 * An action the AI executed (ADR-0028): run at once by the autonomy dial, or after a member
 * approved its proposal. The receipt: what changed (before/after), why (the explanation), the
 * messages it queued, and how to undo it (the inverse, until `undo_until`).
 */
export const aiActionExecutions = pgTable(
  'ai_action_executions',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    tenantId: uuid('tenant_id')
      .notNull()
      .default(currentTenantId)
      .references(() => tenants.id, { onDelete: 'cascade' }),
    proposalId: uuid('proposal_id'),
    action: text('action').notNull(),
    tool: text('tool').notNull(),
    outcome: text('outcome').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status').notNull().default('done'),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    // What the tool's inverse needs; NULL: it cannot be undone.
    inverse: jsonb('inverse'),
    explanation: jsonb('explanation').notNull(),
    outboxMessageIds: uuid('outbox_message_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    // The member the AI acted for (who asked, or who approved); NULL once their account is deleted.
    onBehalfOfUserId: uuid('on_behalf_of_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    // The member whose request it answered (S26): a staff member whose proposal a lead approved
    // sees the receipt too. NULL once their account is deleted.
    requestedByUserId: uuid('requested_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    // The tool's one-sentence summary (its code's words, never the model's); NULL before S26.
    summary: text('summary'),
    recordOwnerUserId: uuid('record_owner_user_id'),
    undoUntil: timestamp('undo_until', { withTimezone: true }),
    undoneByUserId: uuid('undone_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    undoneAt: timestamp('undone_at', { withTimezone: true }),
    undoReason: text('undo_reason'),
    ...timestamps,
  },
  (table) => [
    unique('ai_action_executions_tenant_id_id_unique').on(table.tenantId, table.id),
    unique('ai_action_executions_idempotency_key_unique').on(table.tenantId, table.idempotencyKey),
    unique('ai_action_executions_proposal_unique').on(table.tenantId, table.proposalId),
    foreignKey({
      name: 'ai_action_executions_proposal_fk',
      columns: [table.tenantId, table.proposalId],
      foreignColumns: [aiActionProposals.tenantId, aiActionProposals.id],
    }),
    index('ai_action_executions_recent_idx').on(table.tenantId, table.createdAt),
    index('ai_action_executions_entity_idx').on(table.tenantId, table.entityType, table.entityId),
    index('ai_action_executions_on_behalf_of_user_id_idx').on(table.onBehalfOfUserId),
    index('ai_action_executions_undone_by_user_id_idx').on(table.undoneByUserId),
    index('ai_action_executions_requested_by_user_id_idx').on(table.requestedByUserId),
    check(
      'ai_action_executions_summary_length',
      sql`${table.summary} IS NULL OR char_length(${table.summary}) <= 600`,
    ),
    check('ai_action_executions_action_known', sql`${table.action} IN (${autonomyActionList})`),
    check('ai_action_executions_tool_format', trustCode(table.tool)),
    check('ai_action_executions_entity_type_format', trustCode(table.entityType)),
    check(
      'ai_action_executions_outcome_known',
      sql`${table.outcome} IN ('execute', 'execute_and_notify', 'propose')`,
    ),
    // An approved proposal ran as `propose`; only those have a proposal.
    check(
      'ai_action_executions_proposal_when_proposed',
      sql`(${table.outcome} = 'propose') = (${table.proposalId} IS NOT NULL)`,
    ),
    check(
      'ai_action_executions_idempotency_key_format',
      sql`${table.idempotencyKey} ~ '^[A-Za-z0-9.:_-]{8,200}$'`,
    ),
    check('ai_action_executions_status_known', sql`${table.status} IN ('done', 'undone')`),
    check(
      'ai_action_executions_undone_when_undone',
      sql`(${table.status} = 'undone') = (${table.undoneAt} IS NOT NULL)`,
    ),
    check(
      'ai_action_executions_undo_reason_known',
      sql`${table.undoReason} IS NULL OR (${table.undoReason} IN ('wrong', 'changed_mind', 'other') AND ${table.status} = 'undone')`,
    ),
    check(
      'ai_action_executions_undo_needs_inverse',
      sql`(${table.inverse} IS NULL) = (${table.undoUntil} IS NULL)`,
    ),
    check('ai_action_executions_outbox_links', sql`cardinality(${table.outboxMessageIds}) <= 100`),
    check('ai_action_executions_before_size', trustJsonSize(table.before)),
    check('ai_action_executions_after_size', trustJsonSize(table.after)),
    check('ai_action_executions_inverse_size', trustJsonSize(table.inverse)),
    check('ai_action_executions_explanation_size', trustJsonSize(table.explanation)),
    tenantIsolation(sql.raw('tenant_id')),
    pgPolicy('member_scope', {
      as: 'restrictive',
      for: 'all',
      using: sql`${memberSeesAll} OR on_behalf_of_user_id = ${currentUserId} OR requested_by_user_id = ${currentUserId}`,
      withCheck: sql`${memberSeesAll} OR on_behalf_of_user_id = ${currentUserId} OR requested_by_user_id = ${currentUserId}`,
    }),
  ],
);

export type Tenant = typeof tenants.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
// Conversations with the AI (ADR-0030): a member's chats, the turns they start with a message,
// and the messages the model was sent and answered with. Every role reaches only its own
// conversations (a chat is personal; leads oversee the AI through its proposals and receipts),
// and work without a user (the clean-up) reaches all. Messages are written once and never
// changed; a conversation goes 90 days after its last message, with its turns and messages.

/** One conversation of one member. */
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    tenantId: uuid('tenant_id')
      .notNull()
      .default(currentTenantId)
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    channel: text('channel').notNull().default('chat'),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (table) => [
    unique('conversations_tenant_id_id_unique').on(table.tenantId, table.id),
    index('conversations_member_recent_idx').on(table.tenantId, table.userId, table.lastMessageAt),
    index('conversations_retention_idx').on(table.tenantId, table.lastMessageAt),
    foreignKey({
      name: 'conversations_membership_fk',
      columns: [table.tenantId, table.userId],
      foreignColumns: [memberships.tenantId, memberships.userId],
    }).onDelete('cascade'),
    check('conversations_channel_known', sql`${table.channel} IN ('chat', 'voice')`),
    tenantIsolation(sql.raw('tenant_id')),
    pgPolicy('member_scope', {
      as: 'restrictive',
      for: 'all',
      using: sql`${currentUserId} IS NULL OR user_id = ${currentUserId}`,
      withCheck: sql`${currentUserId} IS NULL OR user_id = ${currentUserId}`,
    }),
  ],
);

/**
 * One turn: the member's message and everything the AI did to answer it. At most one turn
 * runs per conversation; the client's turn id makes a retried request find its turn.
 */
export const conversationTurns = pgTable(
  'conversation_turns',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    tenantId: uuid('tenant_id')
      .notNull()
      .default(currentTenantId)
      .references(() => tenants.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').notNull(),
    userId: uuid('user_id').notNull(),
    clientTurnId: uuid('client_turn_id').notNull(),
    status: text('status').notNull().default('running'),
    stopReason: text('stop_reason'),
    // The turn read text from outside the team (tracked by the loop, never by the model).
    untrusted: boolean('untrusted').notNull().default(false),
    steps: smallint('steps').notNull().default(0),
    inputTokens: integer('input_tokens').notNull().default(0),
    cachedInputTokens: integer('cached_input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique('conversation_turns_tenant_id_id_unique').on(table.tenantId, table.id),
    unique('conversation_turns_client_turn_unique').on(
      table.tenantId,
      table.userId,
      table.clientTurnId,
    ),
    uniqueIndex('conversation_turns_one_running')
      .on(table.tenantId, table.conversationId)
      .where(sql`${table.status} = 'running'`),
    index('conversation_turns_conversation_idx').on(table.tenantId, table.conversationId),
    foreignKey({
      name: 'conversation_turns_conversation_fk',
      columns: [table.tenantId, table.conversationId],
      foreignColumns: [conversations.tenantId, conversations.id],
    }).onDelete('cascade'),
    check(
      'conversation_turns_status_known',
      sql`${table.status} IN ('running', 'completed', 'failed', 'cancelled')`,
    ),
    check(
      'conversation_turns_stop_reason_known',
      sql`${table.stopReason} IN ('answered', 'step_limit', 'time_limit', 'provider_unavailable', 'provider_refused', 'budget_exhausted', 'ai_off', 'cancelled', 'interrupted', 'internal')`,
    ),
    check(
      'conversation_turns_finished_when_done',
      sql`(${table.status} = 'running') = (${table.finishedAt} IS NULL) AND (${table.status} = 'running') = (${table.stopReason} IS NULL)`,
    ),
    check('conversation_turns_steps_range', sql`${table.steps} BETWEEN 0 AND 99`),
    check(
      'conversation_turns_tokens_not_negative',
      sql`${table.inputTokens} >= 0 AND ${table.cachedInputTokens} >= 0 AND ${table.outputTokens} >= 0`,
    ),
    tenantIsolation(sql.raw('tenant_id')),
    pgPolicy('member_scope', {
      as: 'restrictive',
      for: 'all',
      using: sql`${currentUserId} IS NULL OR user_id = ${currentUserId}`,
      withCheck: sql`${currentUserId} IS NULL OR user_id = ${currentUserId}`,
    }),
  ],
);

/**
 * One message of a conversation, exactly as the model was sent it (the member's words, its
 * answer with its tool calls, a tool's result) plus what the member saw (a tool's card).
 * `untrusted` marks text from outside the team, and the AI's answers written after it, so the
 * label goes with the text every time it is sent again. Written once, never changed.
 */
export const conversationMessages = pgTable(
  'conversation_messages',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    tenantId: uuid('tenant_id')
      .notNull()
      .default(currentTenantId)
      .references(() => tenants.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').notNull(),
    turnId: uuid('turn_id').notNull(),
    userId: uuid('user_id').notNull(),
    seq: integer('seq').notNull(),
    role: text('role').notNull(),
    content: text('content').notNull(),
    toolCalls: jsonb('tool_calls')
      .notNull()
      .default(sql`'[]'::jsonb`),
    replay: jsonb('replay')
      .notNull()
      .default(sql`'[]'::jsonb`),
    toolCallId: text('tool_call_id'),
    toolName: text('tool_name'),
    isError: boolean('is_error').notNull().default(false),
    card: jsonb('card'),
    // The loop's step that wrote it (assistant and tool messages).
    step: smallint('step'),
    untrusted: boolean('untrusted').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('conversation_messages_tenant_id_id_unique').on(table.tenantId, table.id),
    unique('conversation_messages_seq_unique').on(table.tenantId, table.conversationId, table.seq),
    unique('conversation_messages_tool_result_unique').on(
      table.tenantId,
      table.turnId,
      table.step,
      table.toolCallId,
    ),
    index('conversation_messages_turn_idx').on(table.tenantId, table.turnId),
    foreignKey({
      name: 'conversation_messages_conversation_fk',
      columns: [table.tenantId, table.conversationId],
      foreignColumns: [conversations.tenantId, conversations.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'conversation_messages_turn_fk',
      columns: [table.tenantId, table.turnId],
      foreignColumns: [conversationTurns.tenantId, conversationTurns.id],
    }).onDelete('cascade'),
    check('conversation_messages_role_known', sql`${table.role} IN ('user', 'assistant', 'tool')`),
    check('conversation_messages_seq_positive', sql`${table.seq} >= 1`),
    check('conversation_messages_content_size', sql`length(${table.content}) <= 100000`),
    check(
      'conversation_messages_tool_fields',
      sql`(${table.role} = 'tool') = (${table.toolCallId} IS NOT NULL AND ${table.toolName} IS NOT NULL) AND (${table.role} = 'user') = (${table.step} IS NULL)`,
    ),
    check(
      'conversation_messages_tool_calls_only_assistant',
      sql`jsonb_typeof(${table.toolCalls}) = 'array' AND (${table.role} = 'assistant' OR ${table.toolCalls} = '[]'::jsonb) AND jsonb_array_length(${table.toolCalls}) <= 32`,
    ),
    check(
      'conversation_messages_replay_only_assistant',
      sql`jsonb_typeof(${table.replay}) = 'array' AND (${table.role} = 'assistant' OR ${table.replay} = '[]'::jsonb)`,
    ),
    check(
      'conversation_messages_card_only_tool',
      sql`${table.card} IS NULL OR ${table.role} = 'tool'`,
    ),
    check('conversation_messages_card_size', sql`octet_length(${table.card}::text) <= 32768`),
    check(
      'conversation_messages_tool_name_format',
      sql`${table.toolName} ~ '^[a-z][a-z0-9_]{0,63}$'`,
    ),
    check('conversation_messages_tool_call_id_size', sql`length(${table.toolCallId}) <= 200`),
    check('conversation_messages_step_range', sql`${table.step} BETWEEN 1 AND 99`),
    tenantIsolation(sql.raw('tenant_id')),
    pgPolicy('member_scope', {
      as: 'restrictive',
      for: 'all',
      using: sql`${currentUserId} IS NULL OR user_id = ${currentUserId}`,
      withCheck: sql`${currentUserId} IS NULL OR user_id = ${currentUserId}`,
    }),
  ],
);

/**
 * What Pepper remembers about the business, a client, a staff member, a service or one visit
 * (Phase 7, ADR-0034): one current value per subject and key; the replaced value stays only for
 * the 7-day Undo window. Clients' and visits' facts reach the members who reach that client or
 * booking (staff: their own); facts about the business, staff and services reach everyone,
 * except sensitive ones (owners and managers, and a staff member for their own). Deleting a
 * fact, directly or with its subject, scrubs its value from the business's stored
 * conversations and episodes (trigger in migration 0039).
 */
export const memoryFacts = pgTable(
  'memory_facts',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    tenantId: uuid('tenant_id')
      .notNull()
      .default(currentTenantId)
      .references(() => tenants.id, { onDelete: 'cascade' }),
    subjectType: text('subject_type').notNull(),
    clientId: uuid('client_id'),
    staffMemberId: uuid('staff_member_id'),
    serviceId: uuid('service_id'),
    bookingId: uuid('booking_id'),
    key: text('key').notNull(),
    value: text('value').notNull(),
    // The value before the last change, for Undo only; cleared when `previous_until` passes.
    previousValue: text('previous_value'),
    previousUntil: timestamp('previous_until', { withTimezone: true }),
    sensitive: boolean('sensitive').notNull().default(false),
    status: text('status').notNull().default('active'),
    source: text('source').notNull(),
    // The chat turn it came from; no key, as conversations are deleted after 90 days.
    sourceTurnId: uuid('source_turn_id'),
    // Who saved it; NULL once their account is deleted.
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (table) => [
    unique('memory_facts_tenant_id_id_unique').on(table.tenantId, table.id),
    uniqueIndex('memory_facts_one_active')
      .on(
        table.tenantId,
        table.subjectType,
        sql`coalesce(${table.clientId}, ${table.staffMemberId}, ${table.serviceId}, ${table.bookingId}, ${table.tenantId})`,
        table.key,
      )
      .where(sql`${table.status} = 'active'`),
    index('memory_facts_client_idx')
      .on(table.tenantId, table.clientId)
      .where(sql`${table.clientId} IS NOT NULL`),
    index('memory_facts_staff_member_idx')
      .on(table.tenantId, table.staffMemberId)
      .where(sql`${table.staffMemberId} IS NOT NULL`),
    index('memory_facts_service_idx')
      .on(table.tenantId, table.serviceId)
      .where(sql`${table.serviceId} IS NOT NULL`),
    index('memory_facts_booking_idx')
      .on(table.tenantId, table.bookingId)
      .where(sql`${table.bookingId} IS NOT NULL`),
    index('memory_facts_previous_until_idx')
      .on(table.tenantId, table.previousUntil)
      .where(sql`${table.previousUntil} IS NOT NULL`),
    index('memory_facts_created_by_user_id_idx').on(table.createdByUserId),
    foreignKey({
      name: 'memory_facts_client_fk',
      columns: [table.tenantId, table.clientId],
      foreignColumns: [clients.tenantId, clients.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'memory_facts_staff_member_fk',
      columns: [table.tenantId, table.staffMemberId],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'memory_facts_service_fk',
      columns: [table.tenantId, table.serviceId],
      foreignColumns: [services.tenantId, services.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'memory_facts_booking_fk',
      columns: [table.tenantId, table.bookingId],
      foreignColumns: [bookings.tenantId, bookings.id],
    }).onDelete('cascade'),
    check(
      'memory_facts_subject_type_known',
      sql`${table.subjectType} IN ('business', 'client', 'staff', 'service', 'booking')`,
    ),
    // Exactly the key of its subject type is set (none for the business).
    check(
      'memory_facts_subject_shape',
      sql`num_nonnulls(${table.clientId}, ${table.staffMemberId}, ${table.serviceId}, ${table.bookingId}) = (CASE WHEN ${table.subjectType} = 'business' THEN 0 ELSE 1 END) AND (${table.subjectType} <> 'client' OR ${table.clientId} IS NOT NULL) AND (${table.subjectType} <> 'staff' OR ${table.staffMemberId} IS NOT NULL) AND (${table.subjectType} <> 'service' OR ${table.serviceId} IS NOT NULL) AND (${table.subjectType} <> 'booking' OR ${table.bookingId} IS NOT NULL)`,
    ),
    check('memory_facts_key_format', sql`${table.key} ~ '^[a-z][a-z0-9_]{0,39}$'`),
    check('memory_facts_value_length', sql`length(${table.value}) BETWEEN 1 AND 500`),
    check(
      'memory_facts_previous_value',
      sql`(${table.previousValue} IS NULL) = (${table.previousUntil} IS NULL) AND length(${table.previousValue}) BETWEEN 1 AND 500`,
    ),
    check('memory_facts_status_known', sql`${table.status} IN ('active', 'proposed')`),
    check('memory_facts_source_known', sql`${table.source} IN ('screen', 'chat', 'ai_action')`),
    tenantIsolation(sql.raw('tenant_id')),
    // Restrictive policies narrow `tenant_isolation`: what a member may read, and the narrower
    // set they may change.
    pgPolicy('member_scope_read', {
      as: 'restrictive',
      for: 'select',
      using: sql`${memberSeesAll} OR ${memoryFactReachable} OR (subject_type IN ('business', 'staff', 'service') AND NOT sensitive)`,
    }),
    pgPolicy('member_scope_insert', {
      as: 'restrictive',
      for: 'insert',
      withCheck: sql`${memberSeesAll} OR ${memoryFactReachable}`,
    }),
    pgPolicy('member_scope_update', {
      as: 'restrictive',
      for: 'update',
      using: sql`${memberSeesAll} OR ${memoryFactReachable}`,
      withCheck: sql`${memberSeesAll} OR ${memoryFactReachable}`,
    }),
    pgPolicy('member_scope_delete', {
      as: 'restrictive',
      for: 'delete',
      using: sql`${memberSeesAll} OR ${memoryFactReachable}`,
    }),
  ],
);

/**
 * A short summary of one past conversation (Phase 7, ADR-0034), with the clients it names and
 * its embedding for semantic recall. Own-only, like conversations (ADR-0030): each member
 * reaches only their own; work without a user reaches all. Goes with its member, and with any
 * client it names (trigger in migration 0039); kept 365 days.
 */
export const memoryEpisodes = pgTable(
  'memory_episodes',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    tenantId: uuid('tenant_id')
      .notNull()
      .default(currentTenantId)
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    // The conversation it summarises; no key, as conversations are deleted after 90 days.
    conversationId: uuid('conversation_id'),
    summary: text('summary').notNull(),
    clientIds: uuid('client_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    // The facts its conversation saved or recalled (S31, ADR-0037): forgetting one of them
    // deletes the episode, however the summary worded it.
    factIds: uuid('fact_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    // The conversation's last turn it covers: the job's idempotency key (no key, like the
    // conversation).
    lastTurnId: uuid('last_turn_id'),
    embedding: vector('embedding', { dimensions: 1536 }).notNull(),
    embeddingModel: text('embedding_model').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('memory_episodes_tenant_id_id_unique').on(table.tenantId, table.id),
    // One episode per conversation, replaced when it continues (S31 D-3).
    uniqueIndex('memory_episodes_conversation_unique')
      .on(table.tenantId, table.conversationId)
      .where(sql`${table.conversationId} IS NOT NULL`),
    index('memory_episodes_fact_ids_idx').using('gin', table.factIds),
    index('memory_episodes_member_idx').on(table.tenantId, table.userId, table.createdAt),
    index('memory_episodes_created_at_idx').on(table.tenantId, table.createdAt),
    index('memory_episodes_client_ids_idx').using('gin', table.clientIds),
    foreignKey({
      name: 'memory_episodes_membership_fk',
      columns: [table.tenantId, table.userId],
      foreignColumns: [memberships.tenantId, memberships.userId],
    }).onDelete('cascade'),
    check('memory_episodes_summary_length', sql`length(${table.summary}) BETWEEN 1 AND 1000`),
    check('memory_episodes_client_count', sql`cardinality(${table.clientIds}) <= 20`),
    check('memory_episodes_fact_count', sql`cardinality(${table.factIds}) <= 100`),
    check(
      'memory_episodes_embedding_model_format',
      sql`${table.embeddingModel} ~ '^[a-z0-9][a-z0-9._-]{0,79}$'`,
    ),
    tenantIsolation(sql.raw('tenant_id')),
    pgPolicy('member_scope', {
      as: 'restrictive',
      for: 'all',
      using: sql`${currentUserId} IS NULL OR user_id = ${currentUserId}`,
      withCheck: sql`${currentUserId} IS NULL OR user_id = ${currentUserId}`,
    }),
  ],
);

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type InviteRow = typeof invites.$inferSelect;
export type ServiceRow = typeof services.$inferSelect;
export type StaffMemberRow = typeof staffMembers.$inferSelect;
export type WorkingHoursRow = typeof workingHours.$inferSelect;
export type TimeOffRow = typeof timeOff.$inferSelect;
export type BookingRuleRow = typeof bookingRules.$inferSelect;
export type ClientRow = typeof clients.$inferSelect;
export type BookingRow = typeof bookings.$inferSelect;
export type BookingOccupancyRow = typeof bookingOccupancy.$inferSelect;
export type WaitlistEntryRow = typeof waitlistEntries.$inferSelect;
export type BookingReminderRow = typeof bookingReminders.$inferSelect;
export type BookingVerificationRow = typeof bookingVerifications.$inferSelect;
export type OutboxMessageRow = typeof outboxMessages.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;
export type AutonomySettingsRow = typeof autonomySettings.$inferSelect;
export type AiActionProposalRow = typeof aiActionProposals.$inferSelect;
export type AiActionExecutionRow = typeof aiActionExecutions.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type ConversationTurnRow = typeof conversationTurns.$inferSelect;
export type ConversationMessageRow = typeof conversationMessages.$inferSelect;
export type MemoryFactRow = typeof memoryFacts.$inferSelect;
export type MemoryEpisodeRow = typeof memoryEpisodes.$inferSelect;
