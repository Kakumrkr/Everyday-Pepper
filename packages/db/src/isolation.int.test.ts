// Cross-tenant isolation suite (docs/engineering/testing-strategy.md; must stay at 100%).
// Every table in `public` must be listed in TENANT_TABLES (row access limited by RLS) or in
// GLOBAL_TABLES (with a reason); the catalog test fails for a table that is in neither.
import { randomBytes } from 'node:crypto';
import {
  BookingIdSchema,
  ClientIdSchema,
  ImportBatchIdSchema,
  EMBEDDING_DIMENSIONS,
  OutboxMessageIdSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  TenantIdSchema,
  UsagePeriodSchema,
  WaitlistEntryIdSchema,
  WaitlistMatchIdSchema,
  type ActionExplanation,
  type ConversationId,
  type ConversationTurnId,
  type StaffMemberId,
  type TenantId,
  type ClientId,
  type UserId,
} from '@pepper/contracts';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from './client.js';
import { newId } from './ids.js';
import { APP_ROLE } from './migrate.js';
import {
  insertService,
  insertStaffMember,
  insertTimeOff,
  replaceBookingRules,
  replaceStaffServices,
  replaceWorkingHours,
} from './repositories/appointments.js';
import { recordActivation } from './repositories/activation.js';
import { appendAuditEntry } from './repositories/audit.js';
import { recordFunnelStep } from './repositories/booking-funnel.js';
import { insertApprovalText } from './repositories/approval-texts.js';
import { insertBookingManageLink, insertBookingText } from './repositories/booking-texts.js';
import { insertBookingVerification } from './repositories/booking-verifications.js';
import { insertBusinessPhoto } from './repositories/business-photos.js';
import { insertBooking, insertWaitlistEntry } from './repositories/bookings.js';
import {
  deleteClientRow,
  findClient,
  insertClient,
  insertWalkInClient,
  mergeClientRows,
} from './repositories/clients.js';
import { insertImportBatch, insertImportRefs, replaceImportRows } from './repositories/imports.js';
import { insertConversation, insertMessage, insertTurn } from './repositories/conversations.js';
import { insertInvite, withInviteTenant } from './repositories/invites.js';
import { addMembership, listUserBusinesses } from './repositories/memberships.js';
import { insertMemoryEpisode, insertMemoryFact } from './repositories/memory.js';
import { insertBookingFee } from './repositories/booking-fees.js';
import {
  replaceConnectState,
  saveCalendarConnection,
  storeCalendarRead,
} from './repositories/calendar-sync.js';
import { insertBookingPayment, moveBookingPayment } from './repositories/booking-payments.js';
import { insertPaymentAccount } from './repositories/payments.js';
import { insertRememberedDevice } from './repositories/remembered-devices.js';
import { listTenantIdsForCleanup } from './repositories/cleanup.js';
import { insertOutboxMessage, listDueOutboxMessages } from './repositories/outbox.js';
import { savePushSubscription } from './repositories/push-subscriptions.js';
import { listDueBookingReminders, planBookingReminder } from './repositories/reminders.js';
import {
  insertSupportThread,
  listDueSupportThreads,
  markSupportThreadRead,
} from './repositories/support.js';
import { insertSupportScreenshot } from './repositories/support-screenshots.js';
import { insertSmsConsent, insertSmsDelivery } from './repositories/sms.js';
import { insertTask, listDueTasks } from './repositories/tasks.js';
import { listDueInsightRuns, requestInsightRun, syncFeedItems } from './repositories/feed.js';
import { createTenant, withPublicTenant } from './repositories/tenants.js';
import { insertExecution, insertProposal, saveAutonomySettings } from './repositories/trust.js';
import { addUsage } from './repositories/usage.js';
import {
  insertWaitlistMatch,
  insertWaitlistOffer,
  listDueWaitlistMatches,
} from './repositories/waitlist.js';
import { withMember, withTenant, withUser, type TenantTx } from './tenant.js';
import { insertUser, sqlState, startTestDatabase, type TestDatabase } from './test-support.js';

/**
 * Tables that are not tenant-owned, with why. Most have no RLS: the services' role reads and
 * writes them, and only Better Auth (through `authDatabaseAdapter`) and the session repository
 * use them (ADR-0012). The support console's (S59.2, ADR-0062) are proven in
 * `operator.int.test.ts`: no privilege for the services, or forced RLS for operators only.
 */
/** The operator policies' predicate (S59.2), as Postgres prints it. */
const OPERATOR_ACCESS = '(( SELECT current_operator_id() AS current_operator_id) IS NOT NULL)';

const GLOBAL_TABLES: Record<string, string> = {
  users: 'auth identity; one person may belong to several businesses',
  sessions: 'Better Auth looks sessions up by cookie token before any tenant is known',
  accounts: 'sign-in methods (password hash) of a global user',
  verifications: 'short-lived Better Auth tokens, keyed by identifier, not by tenant',
  two_factors: 'TOTP secret and backup codes of a global user',
  user_phones: 'a global user’s own checked mobile number (S63, ADR-0066), keyed by the user',
  signup_events:
    'an account’s sign-up (S45, ADR-0046), before any business; its id and the time only',
  public_support_requests:
    'a request from someone who can’t sign in (S59, PCR-010): no business to belong to; forced RLS, the form inserts, an operator reads (S59.2)',
  platform_operators: 'Pepper’s own team (S59.2, ADR-0062): no privilege for the services',
  operator_access_log:
    'every operator access, kept beyond the business (S59.2): no privilege for the services',
  support_notes:
    'the team’s notes on a business’s or a public request (S59.2): forced RLS, operators only',
  support_saved_replies:
    'the team’s saved replies (S59.2.2, AC-X-23): platform data; forced RLS, operators only',
  inbound_emails:
    'emails at the inbound webhook (S59.3, ADR-0063): stored before any business is known; forced RLS, the inbound context and logged operators only (below)',
  sms_keyword_events:
    'STOP, START and HELP sent to Pepper’s number (S61, ADR-0065): no business; forced RLS, the SMS context and logged operators only (`sms.int.test.ts`)',
  payment_webhook_events:
    'Stripe webhook events (S65, ADR-0067): stored before any business is known; forced RLS, the payments webhook context and logged operators only (`payments.int.test.ts`)',
  email_suppressions:
    'delivery problems Resend reported for an address (S59.3.2, ADR-0063 Part 2): no business; forced RLS, the inbound context and logged operators only (`email-suppression.int.test.ts`)',
};

/**
 * Global tables that name a business once known (`tenant_id`, for its deletion), without a
 * tenant policy: each has forced RLS and exactly the policies listed (their predicates, as
 * Postgres prints them): its own context's, and the logged operator's (S59.3.2's held review),
 * so no tenant transaction reaches them.
 */
const INBOUND_MAIL =
  "COALESCE((current_setting('app.inbound_mail'::text, true) = 'on'::text), false)";
const PAYMENTS_WEBHOOK =
  "COALESCE((current_setting('app.payments_webhook'::text, true) = 'on'::text), false)";
const GLOBAL_TABLES_NAMING_A_BUSINESS: Record<
  string,
  { policyname: string; cmd: string; qual: string; with_check: string | null }[]
> = {
  inbound_emails: [
    { policyname: 'inbound_mail', cmd: 'ALL', qual: INBOUND_MAIL, with_check: INBOUND_MAIL },
    { policyname: 'operator_access', cmd: 'SELECT', qual: OPERATOR_ACCESS, with_check: null },
    {
      policyname: 'operator_review',
      cmd: 'UPDATE',
      qual: `(${OPERATOR_ACCESS} AND (status = 'held'::text))`,
      with_check: OPERATOR_ACCESS,
    },
  ],
  payment_webhook_events: [
    { policyname: 'operator_access', cmd: 'SELECT', qual: OPERATOR_ACCESS, with_check: null },
    {
      policyname: 'payments_webhook',
      cmd: 'ALL',
      qual: PAYMENTS_WEBHOOK,
      with_check: PAYMENTS_WEBHOOK,
    },
  ],
};

interface TenantTable {
  /** Column holding the owning tenant (`id` for `tenants` itself). */
  tenantColumn: string;
  /** Inserts one row owned by the transaction's tenant; returns its id. */
  seed: (tx: TenantTx) => Promise<string>;
  /** A harmless assignment for UPDATE probes. */
  touch: string;
  /** The `member_read` (withUser) predicate, as Postgres prints it, if the table has one. */
  memberRead?: string;
  /** The `invite_lookup` (withInviteTenant) predicate, as Postgres prints it, if any. */
  inviteLookup?: string;
  /** The `public_lookup` (withPublicTenant) predicate, as Postgres prints it, if any. */
  publicLookup?: string;
  /** The `outbox_scan` (listDueOutboxMessages) predicate, as Postgres prints it, if any. */
  outboxScan?: string;
  /** The `job_scan` (withJobScan) predicate, as Postgres prints it, if any. */
  jobScan?: string;
  /**
   * A read for the table's owner only (`TO CURRENT_USER` at migration time), behind one definer
   * function: `support_inbound_thread` (S59.3, ADR-0063) finds a thread by its reference;
   * `support_inbound_member` (S59.3.2) finds the business of an email's sender.
   */
  ownerLookup?: string;
  /**
   * Has the `operator_read` policy (withOperator, S59.2, ADR-0062): `true` for the plain one, or
   * its predicate as Postgres prints it when it narrows further (screenshots: sent ones only).
   */
  operatorRead?: true | string;
  /** The services may only insert and read (no UPDATE or DELETE grant). */
  appendOnly?: true;
  /** The services may insert, read and update, but not delete (receipts, ADR-0028). */
  noDelete?: true;
  /** The services may insert, read and delete, but not update (episodes, ADR-0034). */
  noUpdate?: true;
  /** A trigger refuses changes to the row's identity and content (ADR-0028): P0001. */
  guarded?: true;
  /**
   * The restrictive `member_scope*` policies (staff reach only their own records, ADR-0017),
   * as Postgres prints them; the staff scope itself is proven in bookings.int.test.ts.
   */
  memberScope?: {
    policyname: string;
    cmd: string;
    qual: string | null;
    with_check: string | null;
  }[];
}

/** The member-scope predicate on a staff member column, as Postgres prints it. */
const OWN_STAFF =
  '(( SELECT current_member_sees_all() AS current_member_sees_all) OR (staff_member_id IN ( SELECT current_member_staff_ids() AS current_member_staff_ids)))';
const SEES_ALL = '( SELECT current_member_sees_all() AS current_member_sees_all)';
/** A memory fact a staff member reaches through its subject, as Postgres prints it. */
const MEMORY_REACHABLE =
  "(((subject_type = 'client'::text) AND (client_id IN ( SELECT clients.id\n   FROM clients))) OR ((subject_type = 'booking'::text) AND (booking_id IN ( SELECT bookings.id\n   FROM bookings))) OR ((subject_type = 'staff'::text) AND (staff_member_id IN ( SELECT current_member_staff_ids() AS current_member_staff_ids))))";

/** The feed's member scope: staff reach the items addressed to their staff member. */
const OWN_AUDIENCE =
  '(( SELECT current_member_sees_all() AS current_member_sees_all) OR (audience_staff_id IN ( SELECT current_member_staff_ids() AS current_member_staff_ids)))';

const TENANT_TABLES: Record<string, TenantTable> = {
  activation_events: {
    tenantColumn: 'tenant_id',
    // A business's first steps (S45, ADR-0046): appended once per kind, never changed.
    seed: async (tx) => {
      await recordActivation(tx, 'first_booking');
      const { rows } = await tx.execute<{ id: string }>(sql`SELECT current_tenant_id() AS id`);
      return idWhere(tx, 'activation_events', 'tenant_id', String(rows[0]?.id));
    },
    touch: 'kind = kind',
    appendOnly: true,
  },
  tenants: {
    tenantColumn: 'id',
    // The tenant row already exists; return the transaction's tenant.
    seed: async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`SELECT current_tenant_id() AS id`);
      return String(rows[0]?.id);
    },
    touch: "name = name || ''",
    memberRead:
      '((current_tenant_id() IS NULL) AND (id IN ( SELECT memberships.tenant_id\n   FROM memberships\n  WHERE (memberships.user_id = current_user_id()))))',
    publicLookup: '((current_tenant_id() IS NULL) AND (slug = current_public_slug()))',
    jobScan: "((current_tenant_id() IS NULL) AND current_job_scan('cleanup'::text))",
    // The names a reply to Pepper's number gives (S61.2, `sms_consent_businesses`).
    ownerLookup: 'sms_reply_lookup',
  },
  memberships: {
    tenantColumn: 'tenant_id',
    seed: async (tx) =>
      (await addMembership(tx, { userId: await insertUser(db), role: 'staff' })).id,
    touch: "role = 'manager'",
    memberRead: '((current_tenant_id() IS NULL) AND (user_id = current_user_id()))',
    ownerLookup: 'inbound_member_lookup',
    memberScope: [
      {
        policyname: 'member_scope_delete',
        cmd: 'DELETE',
        qual: `(${SEES_ALL} OR (user_id = current_user_id()))`,
        with_check: null,
      },
      { policyname: 'member_scope_update', cmd: 'UPDATE', qual: 'true', with_check: SEES_ALL },
    ],
  },
  audit_log: {
    tenantColumn: 'tenant_id',
    seed: async (tx) => {
      const entityId = newId();
      await appendAuditEntry(tx, {
        actor: { kind: 'system' },
        change: {
          action: 'membership.removed',
          entity: { type: 'membership', id: entityId },
          before: { userId: await insertUser(db), role: 'staff' },
          after: null,
        },
      });
      const { rows } = await tx.execute<{ id: string }>(
        sql`SELECT id::text FROM audit_log WHERE entity_id = ${entityId}`,
      );
      return String(rows[0]?.id);
    },
    touch: 'action = action',
    appendOnly: true,
  },
  usage_meters: {
    tenantColumn: 'tenant_id',
    seed: async (tx) => {
      await addUsage(tx, {
        metric: 'llm_tokens',
        period: UsagePeriodSchema.parse('2026-10'),
        amount: 1,
      });
      const { rows } = await tx.execute<{ id: string }>(sql`SELECT id::text FROM usage_meters`);
      return String(rows[0]?.id);
    },
    touch: 'amount = amount + 1',
  },
  invites: {
    tenantColumn: 'tenant_id',
    seed: async (tx) =>
      (
        await insertInvite(tx, {
          email: `invitee-${newId()}@example.test`,
          role: 'staff',
          tokenHash: randomBytes(32).toString('hex'),
          invitedBy: await insertUser(db),
          expiresAt: new Date(Date.now() + 86_400_000),
        })
      ).id,
    touch: "role = 'owner'",
    inviteLookup: '((current_tenant_id() IS NULL) AND (token_hash = current_invite_token_hash()))',
  },
  services: {
    tenantColumn: 'tenant_id',
    seed: async (tx) =>
      (
        await insertService(tx, {
          name: `Haircut ${newId()}`,
          category: null,
          durationMinutes: 60,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          priceFromCents: 6500,
          priceToCents: null,
          active: true,
        })
      ).id,
    touch: "name = name || ''",
  },
  staff_members: {
    tenantColumn: 'tenant_id',
    seed: seedStaff,
    touch: 'active = NOT active',
    memberScope: [
      { policyname: 'member_scope_delete', cmd: 'DELETE', qual: SEES_ALL, with_check: null },
      { policyname: 'member_scope_insert', cmd: 'INSERT', qual: null, with_check: SEES_ALL },
      { policyname: 'member_scope_update', cmd: 'UPDATE', qual: 'true', with_check: SEES_ALL },
    ],
  },
  staff_services: {
    tenantColumn: 'tenant_id',
    seed: async (tx) => {
      const staff = await seedStaff(tx);
      const service = await insertService(tx, {
        name: `Colour ${newId()}`,
        category: null,
        durationMinutes: 90,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        priceFromCents: null,
        priceToCents: null,
        active: true,
      });
      await replaceStaffServices(tx, staff, [ServiceIdSchema.parse(service.id)]);
      return idWhere(tx, 'staff_services', 'staff_member_id', staff);
    },
    touch: 'created_at = created_at',
  },
  working_hours: {
    tenantColumn: 'tenant_id',
    seed: async (tx) => {
      const staff = await seedStaff(tx);
      await replaceWorkingHours(tx, staff, [{ weekday: 1, startMinute: 540, endMinute: 1020 }]);
      return idWhere(tx, 'working_hours', 'staff_member_id', staff);
    },
    touch: 'weekday = weekday',
  },
  time_off: {
    tenantColumn: 'tenant_id',
    seed: async (tx) =>
      (
        await insertTimeOff(tx, {
          staffMemberId: await seedStaff(tx),
          startsAt: new Date('2026-10-20T13:00:00Z'),
          endsAt: new Date('2026-10-20T17:00:00Z'),
          createdBy: await insertUser(db),
        })
      ).id,
    touch: 'created_at = created_at',
  },
  booking_rules: {
    tenantColumn: 'tenant_id',
    seed: async (tx) => {
      const staff = await seedStaff(tx);
      await replaceBookingRules(tx, [
        { type: 'max_bookings_per_day', version: 1, staffMemberId: staff, params: { count: 6 } },
      ]);
      return idWhere(tx, 'booking_rules', 'staff_member_id', staff);
    },
    touch: 'version = version',
  },
  clients: {
    tenantColumn: 'tenant_id',
    seed: async (tx) => (await seedClient(tx)).toString(),
    touch: "name = name || ''",
    memberScope: [
      {
        policyname: 'member_scope',
        cmd: 'ALL',
        qual: '(( SELECT current_member_sees_all() AS current_member_sees_all) OR (id IN ( SELECT bookings.client_id\n   FROM bookings)) OR (id IN ( SELECT waitlist_entries.client_id\n   FROM waitlist_entries)) OR ((( SELECT current_client_contact() AS current_client_contact) = email) OR (( SELECT current_client_contact() AS current_client_contact) = phone)))',
        with_check: SEES_ALL,
      },
      { policyname: 'member_scope_delete', cmd: 'DELETE', qual: SEES_ALL, with_check: null },
    ],
  },
  bookings: {
    tenantColumn: 'tenant_id',
    seed: seedBooking,
    touch: "status = 'cancelled'",
    // Which booking a client's "C" confirms (S62, `sms_confirm_target`).
    ownerLookup: 'sms_confirm_lookup',
    memberScope: [
      { policyname: 'member_scope', cmd: 'ALL', qual: OWN_STAFF, with_check: OWN_STAFF },
    ],
  },
  booking_occupancy: {
    tenantColumn: 'tenant_id',
    // The trigger writes the booking's occupied time under the booking's id.
    seed: seedBooking,
    touch: 'starts_at = starts_at',
    memberScope: [
      { policyname: 'member_scope_delete', cmd: 'DELETE', qual: OWN_STAFF, with_check: null },
      { policyname: 'member_scope_insert', cmd: 'INSERT', qual: null, with_check: OWN_STAFF },
      { policyname: 'member_scope_update', cmd: 'UPDATE', qual: OWN_STAFF, with_check: OWN_STAFF },
    ],
  },
  waitlist_entries: {
    tenantColumn: 'tenant_id',
    seed: async (tx) => {
      const service = await seedService(tx);
      return (
        await insertWaitlistEntry(tx, {
          clientId: await seedClient(tx),
          serviceId: service,
          staffMemberId: null,
          windows: [{ date: '2026-10-23', start: '15:00', end: '18:00' }],
          expiresAt: new Date('2026-10-23T22:00:00Z'),
          createdBy: await insertUser(db),
        })
      ).id;
    },
    touch: "status = 'cancelled'",
    memberScope: [
      { policyname: 'member_scope', cmd: 'ALL', qual: OWN_STAFF, with_check: OWN_STAFF },
    ],
  },
  waitlist_matches: {
    tenantColumn: 'tenant_id',
    seed: async (tx) => seedWaitlistMatch(tx),
    touch: 'attempts = attempts',
    memberScope: [
      { policyname: 'member_scope', cmd: 'ALL', qual: OWN_STAFF, with_check: OWN_STAFF },
    ],
    jobScan: "((current_tenant_id() IS NULL) AND current_job_scan('waitlist'::text))",
  },
  waitlist_offers: {
    tenantColumn: 'tenant_id',
    seed: async (tx) => {
      const matchId = WaitlistMatchIdSchema.parse(await seedWaitlistMatch(tx));
      const [match] = await tx
        .execute<{ staff: string }>(
          sql`SELECT staff_member_id::text AS staff FROM waitlist_matches WHERE id = ${matchId}`,
        )
        .then((result) => result.rows);
      const service = await seedService(tx);
      const clientId = await seedClient(tx);
      const entry = await insertWaitlistEntry(tx, {
        clientId,
        serviceId: service,
        staffMemberId: null,
        windows: [{ date: '2026-10-23', start: '15:00', end: '18:00' }],
        expiresAt: new Date('2026-10-23T22:00:00Z'),
        createdBy: await insertUser(db),
      });
      return (
        await insertWaitlistOffer(tx, {
          matchId,
          entryId: WaitlistEntryIdSchema.parse(entry.id),
          clientId,
          serviceId: service,
          staffMemberId: StaffMemberIdSchema.parse(match?.staff),
          startsAt: new Date('2026-10-23T15:00:00Z'),
          rank: 1,
          tokenHash: randomBytes(32).toString('hex'),
          expiresAt: new Date('2026-10-23T14:00:00Z'),
          offeredAt: new Date('2026-10-23T13:50:00Z'),
        })
      ).id;
    },
    touch: 'rank = rank',
    memberScope: [
      { policyname: 'member_scope', cmd: 'ALL', qual: OWN_STAFF, with_check: OWN_STAFF },
      { policyname: 'member_scope_insert', cmd: 'INSERT', qual: null, with_check: SEES_ALL },
    ],
  },
  booking_verifications: {
    tenantColumn: 'tenant_id',
    seed: async (tx) =>
      (
        await insertBookingVerification(tx, {
          serviceId: await seedService(tx),
          staffMemberId: null,
          startsAt: new Date('2026-10-23T15:00:00Z'),
          name: 'Ana Ruiz',
          email: `ana-${newId()}@example.test`,
          phone: null,
          codeHash: randomBytes(32).toString('hex'),
          expiresAt: new Date('2026-10-20T15:10:00Z'),
        })
      ).id,
    touch: 'attempts = attempts + 1',
    // Members never reach booking requests; only the booking page (no user) does.
    memberScope: [
      {
        policyname: 'member_scope',
        cmd: 'ALL',
        qual: '(current_user_id() IS NULL)',
        with_check: '(current_user_id() IS NULL)',
      },
    ],
  },
  remembered_devices: {
    tenantColumn: 'tenant_id',
    // A browser the booking page remembers (S47, ADR-0047): only the token's hash.
    seed: async (tx) =>
      (
        await insertRememberedDevice(tx, {
          email: `ana-${newId()}@example.test`,
          tokenHash: randomBytes(32).toString('hex'),
          expiresAt: new Date('2027-01-20T15:00:00Z'),
          now: new Date('2026-10-20T15:00:00Z'),
        })
      ).id,
    touch: 'last_used_at = last_used_at',
    // Like booking requests: members never reach them; only the booking page (no user) does.
    memberScope: [
      {
        policyname: 'member_scope',
        cmd: 'ALL',
        qual: '(current_user_id() IS NULL)',
        with_check: '(current_user_id() IS NULL)',
      },
    ],
  },
  booking_funnel_events: {
    tenantColumn: 'tenant_id',
    // A visit entering a booking step (S47, ADR-0047): a random visit id, never changed.
    seed: async (tx) => {
      const visitId = newId();
      await recordFunnelStep(tx, { visitId, step: 'service' });
      return idWhere(tx, 'booking_funnel_events', 'visit_id', visitId);
    },
    touch: 'step = step',
    appendOnly: true,
  },
  business_photos: {
    tenantColumn: 'tenant_id',
    // A booking page photo (S47.2, ADR-0048): read by the page and by every member.
    seed: async (tx) =>
      (
        await insertBusinessPhoto(tx, {
          id: newId(),
          kind: 'gallery',
          widths: [320, 640],
          width: 900,
          height: 600,
          caption: null,
        })
      ).id,
    touch: 'caption = caption',
  },
  import_batches: {
    tenantColumn: 'tenant_id',
    // A client import (S48, ADR-0049): owners and managers only; the worker scans committed ones.
    seed: async (tx) => seedImportBatch(tx),
    touch: 'attempts = attempts',
    memberScope: [{ policyname: 'member_scope', cmd: 'ALL', qual: SEES_ALL, with_check: SEES_ALL }],
    jobScan: "((current_tenant_id() IS NULL) AND current_job_scan('imports'::text))",
  },
  import_rows: {
    tenantColumn: 'tenant_id',
    seed: async (tx) => {
      const batchId = await seedImportBatch(tx);
      await replaceImportRows(tx, ImportBatchIdSchema.parse(batchId), [
        {
          position: 0,
          row: 2,
          cells: ['Maria Lopez'],
          name: 'Maria Lopez',
          email: null,
          phone: null,
          externalId: null,
          rowHash: 'a'.repeat(64),
          outcome: 'create',
          reasons: [],
          clientId: null,
          fills: {},
        },
      ]);
      return idWhere(tx, 'import_rows', 'batch_id', batchId);
    },
    touch: 'outcome = outcome',
    memberScope: [{ policyname: 'member_scope', cmd: 'ALL', qual: SEES_ALL, with_check: SEES_ALL }],
  },
  client_import_refs: {
    tenantColumn: 'tenant_id',
    seed: async (tx) => {
      const clientId = await seedClient(tx);
      const batchId = ImportBatchIdSchema.parse(await seedImportBatch(tx));
      await insertImportRefs(tx, batchId, 'square', [{ externalId: newId(), clientId }]);
      return idWhere(tx, 'client_import_refs', 'client_id', clientId);
    },
    touch: 'system = system',
    memberScope: [{ policyname: 'member_scope', cmd: 'ALL', qual: SEES_ALL, with_check: SEES_ALL }],
  },
  outbox_messages: {
    tenantColumn: 'tenant_id',
    seed: async (tx) => {
      const row = await insertOutboxMessage(tx, {
        id: OutboxMessageIdSchema.parse(newId()),
        type: 'email',
        dedupeKey: `isolation:${newId()}`,
        payload: randomBytes(16),
        availableAt: new Date(),
      });
      return String(row?.id);
    },
    touch: 'attempts = attempts + 1',
  },
  outbox_dispatch: {
    tenantColumn: 'tenant_id',
    seed: async (tx) => {
      const row = await insertOutboxMessage(tx, {
        id: OutboxMessageIdSchema.parse(newId()),
        type: 'email',
        dedupeKey: `isolation:${newId()}`,
        payload: randomBytes(16),
        availableAt: new Date(),
      });
      // The dispatch row has the message's id.
      return String(row?.id);
    },
    touch: 'available_at = available_at',
    outboxScan: '((current_tenant_id() IS NULL) AND current_outbox_scan())',
  },
  booking_reminders: {
    tenantColumn: 'tenant_id',
    seed: async (tx) => {
      const bookingId = BookingIdSchema.parse(await seedBooking(tx));
      await planBookingReminder(tx, {
        bookingId,
        dueAt: new Date('2026-10-19T14:00:00Z'),
        startsAt: new Date('2026-10-20T14:00:00Z'),
      });
      // The reminder row has the booking's id.
      return bookingId;
    },
    touch: 'due_at = due_at',
    jobScan: "((current_tenant_id() IS NULL) AND current_job_scan('reminders'::text))",
  },
  tasks: {
    tenantColumn: 'tenant_id',
    seed: async (tx) =>
      (
        await insertTask(tx, {
          title: 'Order color',
          dueAt: new Date('2026-10-19T14:00:00Z'),
          assigneeUserId: null,
          source: 'manual',
          createdBy: null,
        })
      ).id,
    touch: "title = title || ''",
    jobScan: "((current_tenant_id() IS NULL) AND current_job_scan('tasks'::text))",
    memberScope: [
      {
        policyname: 'member_scope',
        cmd: 'ALL',
        qual: `(${SEES_ALL} OR (assignee_user_id = current_user_id()) OR (created_by_user_id = current_user_id()))`,
        with_check: `(${SEES_ALL} OR (assignee_user_id = current_user_id()) OR (created_by_user_id = current_user_id()))`,
      },
    ],
  },
  // Support (S59, PCR-010): the opener and the business's owners and managers read a thread;
  // its messages follow the thread; each member reaches only their own read marks.
  support_threads: {
    tenantColumn: 'tenant_id',
    seed: async (tx) => (await seedSupportThread(tx)).threadId,
    touch: 'kind = kind',
    operatorRead: true,
    ownerLookup: 'inbound_lookup',
    jobScan: "((current_tenant_id() IS NULL) AND current_job_scan('support'::text))",
    memberScope: [
      {
        policyname: 'member_scope',
        cmd: 'ALL',
        qual: `(${SEES_ALL} OR (opened_by_user_id = current_user_id()))`,
        with_check: `(${SEES_ALL} OR (opened_by_user_id = current_user_id()))`,
      },
    ],
  },
  support_messages: {
    tenantColumn: 'tenant_id',
    seed: async (tx) => {
      const { threadId } = await seedSupportThread(tx);
      return idWhere(tx, 'support_messages', 'thread_id', threadId);
    },
    touch: 'body = body',
    appendOnly: true,
    operatorRead: true,
    jobScan: "((current_tenant_id() IS NULL) AND current_job_scan('support'::text))",
    memberScope: [
      {
        policyname: 'member_scope',
        cmd: 'ALL',
        qual: '(thread_id IN ( SELECT support_threads.id\n   FROM support_threads))',
        with_check: '(thread_id IN ( SELECT support_threads.id\n   FROM support_threads))',
      },
    ],
  },
  support_screenshots: {
    tenantColumn: 'tenant_id',
    seed: async (tx) => {
      const id = newId();
      await insertSupportScreenshot(tx, {
        id,
        uploadedBy: await insertUser(db),
        width: 800,
        height: 600,
        widths: [480, 800],
        bytes: 1024,
        now: new Date(),
      });
      return id;
    },
    touch: 'discarded_at = discarded_at',
    operatorRead:
      '((( SELECT current_operator_id() AS current_operator_id) IS NOT NULL) AND (thread_id IS NOT NULL))',
    jobScan: "((current_tenant_id() IS NULL) AND current_job_scan('support'::text))",
    memberScope: [
      {
        policyname: 'member_scope',
        cmd: 'ALL',
        qual: '\nCASE\n    WHEN (thread_id IS NULL) THEN ((current_user_id() IS NULL) OR (uploaded_by_user_id = current_user_id()))\n    ELSE (thread_id IN ( SELECT support_threads.id\n       FROM support_threads))\nEND',
        with_check:
          '\nCASE\n    WHEN (thread_id IS NULL) THEN ((current_user_id() IS NULL) OR (uploaded_by_user_id = current_user_id()))\n    ELSE (thread_id IN ( SELECT support_threads.id\n       FROM support_threads))\nEND',
      },
      {
        policyname: 'member_scope_unsent_delete',
        cmd: 'DELETE',
        qual: '(thread_id IS NULL)',
        with_check: null,
      },
    ],
  },
  sms_consents: {
    tenantColumn: 'tenant_id',
    seed: async (tx) => {
      const clientId = await seedClient(tx);
      const digits = String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
      const { id } = await insertSmsConsent(tx, {
        phone: `+12${digits}`,
        source: 'booking_page',
        clientId,
        wordingVersion: 'sms-consent-v1',
        shownText: SHOWN,
        givenAt: new Date(),
      });
      return id;
    },
    touch: 'given_at = given_at',
    ownerLookup: 'sms_reply_lookup',
  },
  payment_accounts: {
    tenantColumn: 'tenant_id',
    // One per business (S65, ADR-0067 §4): never deleted by the services.
    seed: async (tx) => {
      const row = await insertPaymentAccount(tx, {
        provider: 'sandbox',
        providerAccountId: `acct_sandbox${randomBytes(8).toString('hex')}`,
        generation: 1,
        livemode: false,
        status: 'onboarding',
        snapshot: {
          chargesEnabled: false,
          payoutsEnabled: false,
          detailsSubmitted: false,
          currentlyDue: ['external_account'],
          pastDue: [],
          eventuallyDue: ['external_account'],
          pendingVerification: [],
          currentDeadline: null,
          disabledReason: null,
        },
        syncedAt: new Date(),
        createdBy: await insertUser(db),
      });
      if (row === undefined) throw new Error('seed payment account not stored');
      return row.id;
    },
    touch: 'status = status',
    noDelete: true,
    ownerLookup: 'payment_account_lookup',
  },
  booking_payments: {
    tenantColumn: 'tenant_id',
    // A booking page payment (S66, ADR-0068 §6): never deleted by the services.
    seed: async (tx) => {
      const row = await insertBookingPayment(tx, {
        requestId: newId(),
        provider: 'sandbox',
        livemode: false,
        kind: 'deposit',
        intentId: `pi_sandbox${randomBytes(8).toString('hex')}`,
        customerId: `cus_sandbox${randomBytes(8).toString('hex')}`,
        accountId: `acct_sandbox${randomBytes(8).toString('hex')}`,
        amountCents: 1500,
        refundHours: 24,
      });
      if (row === undefined) throw new Error('seed booking payment not stored');
      return row.id;
    },
    touch: 'status = status',
    noDelete: true,
    ownerLookup: 'booking_payment_sweep',
  },
  calendar_connections: {
    tenantColumn: 'tenant_id',
    // A staff member's Google Calendar (S70, ADR-0069): sealed tokens, read across businesses
    // by the sync's scan (ids only).
    seed: async (tx) => (await seedCalendarConnection(tx)).id,
    touch: 'status = status',
    jobScan: "((current_tenant_id() IS NULL) AND current_job_scan('calendar'::text))",
  },
  calendar_connect_states: {
    tenantColumn: 'tenant_id',
    seed: async (tx) => {
      const staffMemberId = await seedStaff(tx);
      const membership = await addMembership(tx, { userId: await insertUser(db), role: 'staff' });
      const stateHash = randomBytes(32);
      await replaceConnectState(
        tx,
        {
          staffMemberId,
          membershipId: membership.id,
          stateHash,
          verifierSealed: randomBytes(60),
          expiresAt: new Date(Date.now() + 600_000),
        },
        new Date(),
      );
      return rowId(tx, 'calendar_connect_states', 'staff_member_id', staffMemberId);
    },
    touch: 'expires_at = expires_at',
  },
  calendar_busy_blocks: {
    tenantColumn: 'tenant_id',
    seed: async (tx) => {
      const connection = await seedCalendarConnection(tx);
      await storeCalendarRead(
        tx,
        connection,
        [{ start: Date.parse('2026-12-01T15:00:00Z'), end: Date.parse('2026-12-01T16:00:00Z') }],
        new Date(),
      );
      return rowId(tx, 'calendar_busy_blocks', 'connection_id', connection.id);
    },
    touch: 'ends_at = ends_at',
  },
  calendar_event_syncs: {
    tenantColumn: 'tenant_id',
    // A booking written to Google Calendar (S71, ADR-0069 §10): queued by the trigger on
    // bookings, read across businesses by the sync's scan (ids only).
    seed: async (tx) => {
      const bookingId = await seedBooking(tx);
      await tx.execute(
        sql`INSERT INTO calendar_event_syncs (id, booking_id) VALUES (gen_random_uuid(), ${bookingId})`,
      );
      return rowId(tx, 'calendar_event_syncs', 'booking_id', bookingId);
    },
    touch: 'attempts = attempts',
    jobScan: "((current_tenant_id() IS NULL) AND current_job_scan('calendar'::text))",
  },
  booking_fees: {
    tenantColumn: 'tenant_id',
    // A no-show fee the owner approved (S68, AC-X-142): the dispute record, never deleted.
    seed: async (tx) => {
      const bookingId = await seedBooking(tx);
      const payment = await insertBookingPayment(tx, {
        requestId: newId(),
        provider: 'sandbox',
        livemode: false,
        kind: 'card',
        intentId: `seti_sandbox${randomBytes(8).toString('hex')}`,
        customerId: `cus_sandbox${randomBytes(8).toString('hex')}`,
        accountId: `acct_sandbox${randomBytes(8).toString('hex')}`,
        amountCents: 0,
        refundHours: 24,
      });
      if (payment === undefined) throw new Error('seed booking payment not stored');
      await moveBookingPayment(tx, payment.id, ['started'], { status: 'card_saved', bookingId });
      const row = await insertBookingFee(tx, {
        bookingId,
        bookingPaymentId: payment.id,
        provider: 'sandbox',
        livemode: false,
        amountCents: 2000,
        policySentence: 'No-shows may be charged $20.',
        agreedAt: new Date('2026-10-01T12:00:00Z'),
        approvedBy: newId(),
        approvedAt: new Date('2026-10-21T12:00:00Z'),
      });
      if (row === undefined) throw new Error('seed booking fee not stored');
      return row.id;
    },
    touch: 'status = status',
    noDelete: true,
  },
  booking_texts: {
    tenantColumn: 'tenant_id',
    // What a text to a client was about (S62): one row per queued text.
    seed: async (tx) => {
      const bookingId = BookingIdSchema.parse(await seedBooking(tx));
      const [booking] = await tx
        .execute<{ client_id: string }>(sql`SELECT client_id FROM bookings WHERE id = ${bookingId}`)
        .then((r) => r.rows);
      const id = OutboxMessageIdSchema.parse(newId());
      await insertOutboxMessage(tx, {
        id,
        type: 'sms',
        dedupeKey: `isolation:${newId()}`,
        payload: randomBytes(16),
        availableAt: new Date(),
      });
      await insertBookingText(tx, {
        id,
        clientId: String(booking?.client_id),
        bookingId,
        kind: 'day_before',
        startsAt: new Date('2026-10-20T14:00:00Z'),
        createdAt: new Date(),
      });
      return id;
    },
    touch: 'kind = kind',
    ownerLookup: 'sms_confirm_lookup',
  },
  approval_texts: {
    tenantColumn: 'tenant_id',
    // A card sent to a member by text for their OK (S63): one row per queued text.
    seed: async (tx) => {
      const proposal = await seedProposal(tx);
      const id = OutboxMessageIdSchema.parse(newId());
      await insertOutboxMessage(tx, {
        id,
        type: 'sms',
        dedupeKey: `isolation:${newId()}`,
        payload: randomBytes(16),
        availableAt: new Date(),
      });
      await insertApprovalText(tx, {
        id,
        proposalId: proposal.id,
        userId: await insertUser(db),
        phone: '+15552345678',
        fingerprint: 'a'.repeat(64),
        codeHash: randomBytes(32).toString('hex'),
        expiresAt: new Date(Date.now() + 3_600_000),
        createdAt: new Date(),
      });
      return id;
    },
    touch: 'used_at = used_at',
    ownerLookup: 'sms_approval_lookup',
  },
  booking_manage_links: {
    tenantColumn: 'tenant_id',
    // A reminder's reschedule/cancel link (S62), by its token's hash.
    seed: async (tx) => {
      const tokenHash = randomBytes(32).toString('hex');
      await insertBookingManageLink(tx, {
        bookingId: BookingIdSchema.parse(await seedBooking(tx)),
        tokenHash,
        createdAt: new Date(),
      });
      return idWhere(tx, 'booking_manage_links', 'token_hash', tokenHash);
    },
    touch: 'created_at = created_at',
  },
  sms_deliveries: {
    tenantColumn: 'tenant_id',
    seed: async (tx) => {
      const row = await insertOutboxMessage(tx, {
        id: OutboxMessageIdSchema.parse(newId()),
        type: 'email',
        dedupeKey: `isolation:${newId()}`,
        payload: randomBytes(16),
        availableAt: new Date(),
      });
      const id = String(row?.id);
      await insertSmsDelivery(tx, {
        id,
        provider: 'sandbox',
        providerMessageId: `SB${newId().replace(/-/g, '')}`,
        segments: 1,
        status: 'sent',
      });
      return id;
    },
    touch: 'status = status',
  },
  support_reads: {
    tenantColumn: 'tenant_id',
    seed: async (tx) => {
      const { threadId, userId } = await seedSupportThread(tx);
      await markSupportThreadRead(tx, threadId, userId, new Date());
      return idWhere(tx, 'support_reads', 'thread_id', threadId);
    },
    touch: 'read_at = read_at',
    memberScope: [
      {
        policyname: 'member_scope',
        cmd: 'ALL',
        qual: '((current_user_id() IS NULL) OR (user_id = current_user_id()))',
        with_check: '((current_user_id() IS NULL) OR (user_id = current_user_id()))',
      },
    ],
  },
  push_subscriptions: {
    tenantColumn: 'tenant_id',
    seed: async (tx) => {
      const userId = await insertUser(db);
      await addMembership(tx, { userId, role: 'staff' });
      return (
        await savePushSubscription(tx, {
          userId,
          endpoint: `https://push.example.test/${newId()}`,
          p256dh: 'B'.repeat(87),
          auth: 'a'.repeat(22),
        })
      ).id;
    },
    touch: 'auth = auth',
    // Each member reaches only their own devices; work without a user reaches all.
    memberScope: [
      {
        policyname: 'member_scope',
        cmd: 'ALL',
        qual: '((current_user_id() IS NULL) OR (user_id = current_user_id()))',
        with_check: '((current_user_id() IS NULL) OR (user_id = current_user_id()))',
      },
    ],
  },
  autonomy_settings: {
    tenantColumn: 'tenant_id',
    seed: async (tx) =>
      (
        await saveAutonomySettings(tx, {
          askFirst: false,
          levels: { 'booking.create': 'notify' },
          updatedBy: await insertUser(db),
        })
      ).id,
    touch: 'ask_first = ask_first',
    // Everyone reads it; only owners, managers and work without a user change it.
    memberScope: [
      { policyname: 'member_scope_delete', cmd: 'DELETE', qual: SEES_ALL, with_check: null },
      { policyname: 'member_scope_insert', cmd: 'INSERT', qual: null, with_check: SEES_ALL },
      { policyname: 'member_scope_update', cmd: 'UPDATE', qual: 'true', with_check: SEES_ALL },
    ],
  },
  ai_action_proposals: {
    tenantColumn: 'tenant_id',
    seed: async (tx) => (await seedProposal(tx)).id,
    touch: 'status = status',
    noDelete: true,
    guarded: true,
    memberScope: [
      {
        policyname: 'member_scope',
        cmd: 'ALL',
        qual: `(${SEES_ALL} OR (requested_by_user_id = current_user_id()))`,
        with_check: `(${SEES_ALL} OR (requested_by_user_id = current_user_id()))`,
      },
    ],
  },
  ai_action_executions: {
    tenantColumn: 'tenant_id',
    seed: async (tx) => {
      const execution = await insertExecution(tx, {
        proposalId: null,
        action: 'time.block',
        tool: 'block_time',
        outcome: 'execute_and_notify',
        idempotencyKey: `seed:${newId()}`,
        entity: { type: 'time_off', id: newId() },
        before: null,
        after: { startsAt: '2026-10-20T14:00:00.000Z' },
        undo: { inverse: { timeOffId: newId() }, until: new Date('2026-10-21T14:00:00Z') },
        explanation: EXPLANATION,
        outboxMessageIds: [],
        onBehalfOf: await insertUser(db),
        recordOwner: null,
      });
      return String(execution?.id);
    },
    touch: 'status = status',
    noDelete: true,
    guarded: true,
    memberScope: [
      {
        policyname: 'member_scope',
        cmd: 'ALL',
        qual: `(${SEES_ALL} OR (on_behalf_of_user_id = current_user_id()) OR (requested_by_user_id = current_user_id()))`,
        with_check: `(${SEES_ALL} OR (on_behalf_of_user_id = current_user_id()) OR (requested_by_user_id = current_user_id()))`,
      },
    ],
  },
  conversations: {
    tenantColumn: 'tenant_id',
    seed: async (tx) => (await seedTurn(tx)).conversation.id,
    touch: 'channel = channel',
    // Every role reaches only its own conversations; work without a user reaches all.
    memberScope: [
      {
        policyname: 'member_scope',
        cmd: 'ALL',
        qual: '((current_user_id() IS NULL) OR (user_id = current_user_id()))',
        with_check: '((current_user_id() IS NULL) OR (user_id = current_user_id()))',
      },
    ],
  },
  conversation_turns: {
    tenantColumn: 'tenant_id',
    seed: async (tx) => (await seedTurn(tx)).turn.id,
    touch: 'steps = steps',
    noDelete: true,
    guarded: true,
    // Every role reaches only its own conversations; work without a user reaches all.
    memberScope: [
      {
        policyname: 'member_scope',
        cmd: 'ALL',
        qual: '((current_user_id() IS NULL) OR (user_id = current_user_id()))',
        with_check: '((current_user_id() IS NULL) OR (user_id = current_user_id()))',
      },
    ],
  },
  conversation_messages: {
    tenantColumn: 'tenant_id',
    seed: async (tx) => {
      const { userId, conversation, turn } = await seedTurn(tx);
      const message = await insertMessage(tx, {
        conversationId: conversation.id as ConversationId,
        turnId: turn.id as ConversationTurnId,
        userId,
        role: 'user',
        content: 'What does tomorrow look like?',
        untrusted: false,
      });
      return message.id;
    },
    touch: 'content = content',
    appendOnly: true,
    // Every role reaches only its own conversations; work without a user reaches all.
    memberScope: [
      {
        policyname: 'member_scope',
        cmd: 'ALL',
        qual: '((current_user_id() IS NULL) OR (user_id = current_user_id()))',
        with_check: '((current_user_id() IS NULL) OR (user_id = current_user_id()))',
      },
    ],
  },
  memory_facts: {
    tenantColumn: 'tenant_id',
    seed: async (tx) =>
      (
        await insertMemoryFact(tx, {
          subject: { type: 'business' },
          key: 'prefers',
          value: 'No bookings before 10 on Mondays',
          sensitive: false,
          status: 'active',
          source: 'screen',
          sourceTurnId: null,
          createdBy: null,
        })
      ).id,
    touch: 'value = value',
    guarded: true,
    // Staff reach the facts of the clients and visits they reach, their own staff member's,
    // and the business's non-sensitive ones (proven in memory.int.test.ts).
    memberScope: [
      {
        policyname: 'member_scope_delete',
        cmd: 'DELETE',
        qual: `(${SEES_ALL} OR ${MEMORY_REACHABLE})`,
        with_check: null,
      },
      {
        policyname: 'member_scope_insert',
        cmd: 'INSERT',
        qual: null,
        with_check: `(${SEES_ALL} OR ${MEMORY_REACHABLE})`,
      },
      {
        policyname: 'member_scope_read',
        cmd: 'SELECT',
        qual: `(${SEES_ALL} OR ${MEMORY_REACHABLE} OR ((subject_type = ANY (ARRAY['business'::text, 'staff'::text, 'service'::text])) AND (NOT sensitive)))`,
        with_check: null,
      },
      {
        policyname: 'member_scope_update',
        cmd: 'UPDATE',
        qual: `(${SEES_ALL} OR ${MEMORY_REACHABLE})`,
        with_check: `(${SEES_ALL} OR ${MEMORY_REACHABLE})`,
      },
    ],
  },
  feed_items: {
    tenantColumn: 'tenant_id',
    seed: async (tx) => {
      const staff = await seedStaff(tx);
      await syncFeedItems(
        tx,
        [
          {
            kind: 'schedule_gaps',
            subjectKey: `staff:${staff}`,
            day: '2026-10-20',
            audienceStaffId: staff,
            subjects: { staffMemberId: staff, clientId: null, bookingId: null, serviceId: null },
            payload: { gapCount: 1, openMinutes: 60 },
            expiresAt: new Date('2026-10-20T22:00:00Z'),
          },
        ],
        new Date('2026-10-20T12:00:00Z'),
      );
      return idWhere(tx, 'feed_items', 'dedupe_key', `schedule_gaps:staff:${staff}:2026-10-20`);
    },
    touch: 'payload = payload',
    memberScope: [
      { policyname: 'member_scope', cmd: 'ALL', qual: OWN_AUDIENCE, with_check: OWN_AUDIENCE },
      { policyname: 'member_scope_delete', cmd: 'DELETE', qual: SEES_ALL, with_check: null },
      { policyname: 'member_scope_insert', cmd: 'INSERT', qual: null, with_check: SEES_ALL },
    ],
  },
  insight_runs: {
    tenantColumn: 'tenant_id',
    // createTenant made the row; asking for a run keeps it the only one.
    seed: async (tx) => {
      await requestInsightRun(tx);
      const { rows } = await tx.execute<{ id: string }>(sql`SELECT current_tenant_id() AS id`);
      return idWhere(tx, 'insight_runs', 'tenant_id', String(rows[0]?.id));
    },
    touch: 'last_run_at = last_run_at',
    jobScan: "((current_tenant_id() IS NULL) AND current_job_scan('insights'::text))",
  },
  insight_requests: {
    tenantColumn: 'tenant_id',
    // A booking change asks for a run; the run deletes what it covered.
    seed: async (tx) => {
      await requestInsightRun(tx);
      const { rows } = await tx.execute<{ id: string }>(sql`SELECT current_tenant_id() AS id`);
      return idWhere(tx, 'insight_requests', 'tenant_id', String(rows[0]?.id));
    },
    touch: 'created_at = created_at',
    jobScan: "((current_tenant_id() IS NULL) AND current_job_scan('insights'::text))",
  },
  memory_episodes: {
    tenantColumn: 'tenant_id',
    seed: async (tx) => {
      const userId = await insertUser(db);
      await addMembership(tx, { userId, role: 'staff' });
      return (
        await insertMemoryEpisode(tx, {
          userId,
          conversationId: null,
          summary: 'Decided Jess keeps Saturdays free.',
          clientIds: [],
          embedding: Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0)),
          embeddingModel: 'text-embedding-3-small',
        })
      ).id;
    },
    touch: 'summary = summary',
    noUpdate: true,
    // Every role reaches only its own episodes, like conversations; work without a user all.
    memberScope: [
      {
        policyname: 'member_scope',
        cmd: 'ALL',
        qual: '((current_user_id() IS NULL) OR (user_id = current_user_id()))',
        with_check: '((current_user_id() IS NULL) OR (user_id = current_user_id()))',
      },
    ],
  },
};

/** A new conversation of a new member of the transaction's tenant, with a running turn. */
async function seedTurn(tx: TenantTx) {
  const userId = await insertUser(db);
  await addMembership(tx, { userId, role: 'staff' });
  const conversation = await insertConversation(tx, { userId, channel: 'chat' });
  const turn = await insertTurn(tx, {
    conversationId: conversation.id as ConversationId,
    userId,
    clientTurnId: newId(),
    deadlineAt: new Date(Date.now() + 60_000),
  });
  if (turn === undefined) throw new Error('no turn');
  return { userId, conversation, turn };
}

const EXPLANATION: ActionExplanation = {
  requestMessageId: null,
  steps: [],
  facts: [],
  alternatives: [],
  untrustedContext: false,
  decision: { outcome: 'execute_and_notify', reason: 'setting' },
};

/** A new pending proposal of the transaction's tenant. */
async function seedProposal(tx: TenantTx) {
  const proposal = await insertProposal(tx, {
    action: 'booking.cancel',
    tool: 'cancel_booking',
    targetKey: `booking:${newId()}`,
    idempotencyKey: `seed:${newId()}`,
    payload: { bookingId: newId() },
    preview: { status: 'cancelled' },
    fingerprint: 'a'.repeat(64),
    explanation: { ...EXPLANATION, decision: { outcome: 'propose', reason: 'setting' } },
    requestedBy: await insertUser(db),
    recordOwner: null,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  if (proposal === undefined) throw new Error('seed proposal not stored');
  return proposal;
}

/** A new client of the transaction's tenant. */
async function seedImportBatch(tx: TenantTx) {
  const batch = await insertImportBatch(tx, {
    createdByUserId: null,
    format: 'csv',
    preset: null,
    system: 'file:0123456789abcdef',
    columns: [],
    problems: [],
    counts: { rows: 0, create: 0, merge: 0, unchanged: 0, invalid: 0, skipped: 0 },
  });
  return batch.id;
}

async function seedClient(tx: TenantTx) {
  const client = await insertClient(tx, {
    name: 'Maria Lopez',
    email: `maria-${newId()}@example.test`,
    phone: null,
    source: 'team',
  });
  return ClientIdSchema.parse(client.id);
}

/** A new active service of the transaction's tenant. */
async function seedService(tx: TenantTx) {
  const service = await insertService(tx, {
    name: `Blow-dry ${newId()}`,
    category: null,
    durationMinutes: 45,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    priceFromCents: null,
    priceToCents: null,
    active: true,
  });
  return ServiceIdSchema.parse(service.id);
}

/** A new confirmed booking (with its client, service and staff member); returns its id. */
async function seedBooking(tx: TenantTx): Promise<string> {
  const booking = await insertBooking(tx, {
    clientId: await seedClient(tx),
    serviceId: await seedService(tx),
    staffMemberId: await seedStaff(tx),
    startsAt: new Date('2026-10-20T14:00:00Z'),
    endsAt: new Date('2026-10-20T14:45:00Z'),
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 10,
    priceFromCents: null,
    priceToCents: null,
    source: 'team',
    overridden: false,
    idempotencyKey: null,
    createdBy: null,
  });
  return booking.id;
}

/** A freed slot to match: a booking's time, as a cancellation writes it. */
async function seedWaitlistMatch(tx: TenantTx): Promise<string> {
  const bookingId = BookingIdSchema.parse(await seedBooking(tx));
  const [row] = await tx
    .execute<{ staff: string }>(
      sql`SELECT staff_member_id::text AS staff FROM bookings WHERE id = ${bookingId}`,
    )
    .then((result) => result.rows);
  return insertWaitlistMatch(tx, {
    bookingId,
    staffMemberId: StaffMemberIdSchema.parse(row?.staff),
    startsAt: new Date('2026-10-20T14:00:00Z'),
    endsAt: new Date('2026-10-20T14:45:00Z'),
  });
}

/** A new active staff member of the transaction's tenant. */
async function seedCalendarConnection(tx: TenantTx) {
  const staffMemberId = await seedStaff(tx);
  const userId = await insertUser(db);
  const membership = await addMembership(tx, { userId, role: 'staff' });
  return saveCalendarConnection(
    tx,
    {
      id: newId(),
      staffMemberId,
      membershipId: membership.id,
      provider: 'sandbox',
      accountEmail: 'jess@example.com',
      refreshTokenSealed: randomBytes(60),
      accessTokenSealed: randomBytes(60),
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      createdBy: userId,
      connectedAt: new Date(),
      writesBookings: false,
    },
    false,
  );
}

async function seedStaff(tx: TenantTx): Promise<StaffMemberId> {
  const staff = await insertStaffMember(tx, {
    displayName: 'Jess',
    color: '#2a7230',
    active: true,
    membershipId: null,
  });
  return StaffMemberIdSchema.parse(staff.id);
}

/** The id of the one row of `table` that `column` = `value` selects. */
async function rowId(tx: TenantTx, table: string, column: string, value: string): Promise<string> {
  const result = await tx.execute(
    sql`SELECT id FROM ${sql.identifier(table)} WHERE ${sql.identifier(column)} = ${value}`,
  );
  const id = (result.rows[0] as { id?: unknown } | undefined)?.id;
  if (typeof id !== 'string') throw new Error(`no ${table} row seeded`);
  return id;
}

async function seedSupportThread(tx: TenantTx): Promise<{ threadId: string; userId: UserId }> {
  const userId = await insertUser(db);
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const reference = `PEP-${[...randomBytes(6)].map((byte) => alphabet[byte % 32] ?? '0').join('')}`;
  const row = await insertSupportThread(tx, {
    reference,
    kind: 'question',
    openedByUserId: userId,
    context: { appVersion: 'test' },
    body: 'How do I import my clients?',
    now: new Date(),
  });
  if (row === null) throw new Error('reference taken');
  return { threadId: row.id, userId };
}

async function idWhere(tx: TenantTx, table: string, column: string, value: string) {
  const { rows } = await tx.execute<{ id: string }>(
    sql.raw(`SELECT id::text FROM ${table} WHERE ${column} = '${value}'`),
  );
  return String(rows[0]?.id);
}

/** The words as shown, as core records them (`smsConsentText`). */
const SHOWN = 'Text me appointment confirmations and reminders from A at this number.';
let database: TestDatabase;
let db: Database;
let tenantA: TenantId;
let tenantB: TenantId;
/** Row ids per table, per tenant. */
const rows: Record<string, { a: string; b: string }> = {};

async function seedTenant(slug: string): Promise<TenantId> {
  const tenant = await createTenant(db, { name: slug, slug, timeZone: 'America/New_York' });
  return TenantIdSchema.parse(tenant.id);
}

async function asAdmin<T extends pg.QueryResultRow>(text: string, values: unknown[] = []) {
  const client = new pg.Client({ connectionString: database.migrationUrl });
  await client.connect();
  try {
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end();
  }
}

/** Runs raw SQL as the app role in tenant A's transaction. */
function inTenant<T extends Record<string, unknown>>(tenant: TenantId, statement: string) {
  return withTenant(db, tenant, (tx) => tx.execute<T>(sql.raw(statement)));
}

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  tenantA = await seedTenant('tenant-a');
  tenantB = await seedTenant('tenant-b');
  for (const [table, spec] of Object.entries(TENANT_TABLES)) {
    rows[table] = {
      a: await withTenant(db, tenantA, spec.seed),
      b: await withTenant(db, tenantB, spec.seed),
    };
  }
});

afterAll(async () => {
  await database.stop();
});

describe('catalog', () => {
  it('classifies every table in public as tenant-owned or global', async () => {
    const tables = await asAdmin<{ name: string }>(
      "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY 1",
    );
    const classified = [...Object.keys(TENANT_TABLES), ...Object.keys(GLOBAL_TABLES)].sort();
    expect(tables.map((t) => t.name)).toEqual(classified);
  });

  it('every table with a tenant_id column is in the suite', async () => {
    const tables = await asAdmin<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'tenant_id'`,
    );
    for (const { name } of tables) {
      if (name in GLOBAL_TABLES_NAMING_A_BUSINESS) continue;
      expect(TENANT_TABLES).toHaveProperty(name);
    }
  });

  it.each(Object.entries(GLOBAL_TABLES_NAMING_A_BUSINESS))(
    '%s has forced RLS and only its own context’s and the operator’s policies (no tenant reaches it)',
    async (table, expected) => {
      const [flags] = await asAdmin<{ enabled: boolean; forced: boolean }>(
        `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
           FROM pg_class WHERE oid = $1::regclass`,
        [`public.${table}`],
      );
      expect(flags).toEqual({ enabled: true, forced: true });
      const policies = await asAdmin(
        `SELECT policyname, permissive, cmd, roles::text[] AS roles, qual, with_check
           FROM pg_policies WHERE schemaname = 'public' AND tablename = $1 ORDER BY policyname`,
        [table],
      );
      expect(policies).toEqual(
        expected.map((policy) => ({ ...policy, permissive: 'PERMISSIVE', roles: ['public'] })),
      );
    },
  );

  it.each(Object.entries(TENANT_TABLES))(
    '%s has forced RLS, the tenant_isolation policy and only the policies listed',
    async (table, spec) => {
      const [flags] = await asAdmin<{ enabled: boolean; forced: boolean }>(
        `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
           FROM pg_class WHERE oid = $1::regclass`,
        [`public.${table}`],
      );
      expect(flags).toEqual({ enabled: true, forced: true });
      const policies = await asAdmin(
        `SELECT policyname, permissive, cmd, roles::text[] AS roles, qual, with_check
           FROM pg_policies WHERE schemaname = 'public' AND tablename = $1 ORDER BY policyname`,
        [table],
      );
      const predicate = `(${spec.tenantColumn} = current_tenant_id())`;
      const [owner] = await asAdmin<{ name: string }>('SELECT current_user AS name');
      const expected = [
        ...(spec.ownerLookup === undefined
          ? []
          : [
              {
                policyname: spec.ownerLookup,
                permissive: 'PERMISSIVE',
                cmd: 'SELECT',
                roles: [owner?.name],
                qual: 'true',
                with_check: null,
              },
            ]),
        ...(spec.inviteLookup === undefined
          ? []
          : [
              {
                policyname: 'invite_lookup',
                permissive: 'PERMISSIVE',
                cmd: 'SELECT',
                roles: ['public'],
                qual: spec.inviteLookup,
                with_check: null,
              },
            ]),
        ...(spec.jobScan === undefined
          ? []
          : [
              {
                policyname: 'job_scan',
                permissive: 'PERMISSIVE',
                cmd: 'SELECT',
                roles: ['public'],
                qual: spec.jobScan,
                with_check: null,
              },
            ]),
        ...(spec.memberRead === undefined
          ? []
          : [
              {
                policyname: 'member_read',
                permissive: 'PERMISSIVE',
                cmd: 'SELECT',
                roles: ['public'],
                qual: spec.memberRead,
                with_check: null,
              },
            ]),
        ...(spec.memberScope ?? []).map((policy) => ({
          ...policy,
          permissive: 'RESTRICTIVE',
          roles: ['public'],
        })),
        ...(spec.operatorRead === undefined
          ? []
          : [
              {
                policyname: 'operator_read',
                permissive: 'PERMISSIVE',
                cmd: 'SELECT',
                roles: ['public'],
                qual: spec.operatorRead === true ? OPERATOR_ACCESS : spec.operatorRead,
                with_check: null,
              },
            ]),
        ...(spec.outboxScan === undefined
          ? []
          : [
              {
                policyname: 'outbox_scan',
                permissive: 'PERMISSIVE',
                cmd: 'SELECT',
                roles: ['public'],
                qual: spec.outboxScan,
                with_check: null,
              },
            ]),
        ...(spec.publicLookup === undefined
          ? []
          : [
              {
                policyname: 'public_lookup',
                permissive: 'PERMISSIVE',
                cmd: 'SELECT',
                roles: ['public'],
                qual: spec.publicLookup,
                with_check: null,
              },
            ]),
        {
          policyname: 'tenant_isolation',
          permissive: 'PERMISSIVE',
          cmd: 'ALL',
          roles: ['public'],
          qual: predicate,
          with_check: predicate,
        },
      ].sort((a, b) => (a.policyname < b.policyname ? -1 : 1));
      // In the catalog's order: by name.
      expect(policies).toEqual(expected);
    },
  );
});

describe('the services role', () => {
  it('is not a superuser, cannot bypass RLS and owns nothing', async () => {
    const [role] = await asAdmin(
      `SELECT r.rolsuper, r.rolbypassrls,
              (SELECT count(*)::int FROM pg_class c WHERE c.relowner = r.oid) AS owned
         FROM pg_roles r WHERE r.rolname = $1`,
      [new URL(database.appUrl).username],
    );
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false, owned: 0 });
  });

  it.each([
    ['disable RLS', 'ALTER TABLE tenants DISABLE ROW LEVEL SECURITY'],
    ['drop a policy', 'DROP POLICY tenant_isolation ON memberships'],
    ['create a table', 'CREATE TABLE sneaky (id int)'],
    ['read the migration history', 'SELECT * FROM drizzle.__drizzle_migrations'],
  ])('cannot %s', async (_label, statement) => {
    const error = await db.execute(sql.raw(statement)).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('42501'); // insufficient_privilege
  });

  it('cannot become the migration role', async () => {
    const owner = new URL(database.migrationUrl).username;
    const error = await db.execute(sql.raw(`SET ROLE "${owner}"`)).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('42501');
  });

  it('cannot switch RLS off for its session', async () => {
    const error = await db
      .transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL row_security = off`);
        await tx.execute(sql`SELECT * FROM tenants`);
      })
      .catch((e: unknown) => e);
    // "query would be affected by row-level security policy"
    expect(sqlState(error)).toBe('42501');
  });

  it(`${APP_ROLE} may write every tenant table except the append-only and receipt ones`, async () => {
    const grants = await asAdmin<{ table: string; privileges: string[] }>(
      `SELECT table_name AS table, array_agg(privilege_type::text ORDER BY privilege_type) AS privileges
         FROM information_schema.role_table_grants
        WHERE grantee = $1 AND table_schema = 'public' GROUP BY table_name`,
      [APP_ROLE],
    );
    const byTable = Object.fromEntries(grants.map((g) => [g.table, g.privileges]));
    for (const [table, spec] of Object.entries(TENANT_TABLES)) {
      expect(byTable[table], table).toEqual(
        spec.appendOnly === true
          ? ['INSERT', 'SELECT']
          : spec.noDelete === true
            ? ['INSERT', 'SELECT', 'UPDATE']
            : spec.noUpdate === true
              ? ['DELETE', 'INSERT', 'SELECT']
              : ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      );
    }
  });

  it(`gets its table privileges from ${APP_ROLE}`, async () => {
    const [privileges] = await asAdmin<{ count: number }>(
      `SELECT count(*)::int AS count FROM information_schema.role_table_grants
        WHERE grantee = $1 AND table_schema = 'public'`,
      [new URL(database.appUrl).username],
    );
    expect(privileges?.count).toBe(0);
  });
});

describe.each(Object.entries(TENANT_TABLES))('%s', (table, spec) => {
  const column = spec.tenantColumn;
  const ids = () => {
    const ids = rows[table];
    if (ids === undefined) throw new Error(`no seed rows for ${table}`);
    return ids;
  };

  it('a tenant sees only its own rows', async () => {
    const { rows: seen } = await inTenant<{ id: string; owner: string }>(
      tenantA,
      `SELECT id::text, ${column}::text AS owner FROM ${table}`,
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((row) => row.owner === tenantA)).toBe(true);
    expect(seen.map((row) => row.id)).toContain(ids().a);
  });

  it("another tenant's row cannot be read by id", async () => {
    const { rows: seen } = await inTenant(
      tenantA,
      `SELECT * FROM ${table} WHERE id = '${ids().b}'`,
    );
    expect(seen).toEqual([]);
  });

  /** Runs a write probe: affected row count, or 'denied' on an append-only table. */
  async function write(tenant: TenantId, statement: string): Promise<number | null | 'denied'> {
    if (spec.appendOnly === true || spec.noUpdate === true) {
      const error = await inTenant(tenant, statement).catch((e: unknown) => e);
      expect(sqlState(error)).toBe('42501');
      return 'denied';
    }
    return (await inTenant(tenant, statement)).rowCount;
  }
  const none = spec.appendOnly === true || spec.noUpdate === true ? 'denied' : 0;
  const noDelete = spec.appendOnly === true || spec.noDelete === true ? 'denied' : 0;
  async function remove(tenant: TenantId, statement: string): Promise<number | null | 'denied'> {
    if (spec.noUpdate === true) return (await inTenant(tenant, statement)).rowCount;
    if (spec.noDelete !== true) return write(tenant, statement);
    const error = await inTenant(tenant, statement).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('42501');
    return 'denied';
  }

  it("another tenant's row cannot be updated or deleted", async () => {
    const before = await inTenant(tenantB, `SELECT * FROM ${table} WHERE id = '${ids().b}'`);
    const updated = await write(
      tenantA,
      `UPDATE ${table} SET ${spec.touch} WHERE id = '${ids().b}'`,
    );
    const deleted = await remove(tenantA, `DELETE FROM ${table} WHERE id = '${ids().b}'`);
    expect([updated, deleted]).toEqual([none, noDelete]);
    const after = await inTenant(tenantB, `SELECT * FROM ${table} WHERE id = '${ids().b}'`);
    expect(after.rows).toEqual(before.rows);
    expect(after.rows).toHaveLength(1);
  });

  it('a row cannot be written into another tenant', async () => {
    // Copy tenant A's own row with a new id and B as the owner.
    const insert = await withTenant(db, tenantA, (tx) =>
      tx.execute(
        sql.raw(`INSERT INTO ${table} SELECT (jsonb_populate_record(t, jsonb_build_object(
                   'id', '${newId()}', '${column}', '${tenantB}', 'slug', 'stolen-${String(Date.now())}'))).*
                   FROM ${table} t WHERE id = '${ids().a}'`),
      ),
    ).catch((e: unknown) => e);
    expect(sqlState(insert)).toBe('42501');
  });

  it('a row cannot be moved to another tenant', async () => {
    if (column === 'id') return; // moving a tenant means changing its primary key; covered above
    // 42501 either way: the policy's WITH CHECK, or no UPDATE grant on an append-only table;
    // a guarded table's trigger refuses first (P0001).
    const error = await inTenant(
      tenantA,
      `UPDATE ${table} SET ${column} = '${tenantB}' WHERE id = '${ids().a}'`,
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe(spec.guarded === true ? 'P0001' : '42501');
    const unchanged = await inTenant<{ owner: string }>(
      tenantA,
      `SELECT ${column}::text AS owner FROM ${table} WHERE id = '${ids().a}'`,
    );
    expect(unchanged.rows).toEqual([{ owner: tenantA }]);
  });

  it('nothing is visible without a tenant', async () => {
    const outside = await db.execute(sql.raw(`SELECT * FROM ${table}`));
    const inTransaction = await db.transaction((tx) =>
      tx.execute(sql.raw(`SELECT * FROM ${table}`)),
    );
    expect([outside.rows, inTransaction.rows]).toEqual([[], []]);
  });

  it('nothing can be changed without a tenant', async () => {
    const probe = async (statement: string) => {
      if (spec.appendOnly !== true && !(spec.noUpdate === true && statement.startsWith('UPDATE')))
        return (await db.execute(sql.raw(statement))).rowCount;
      const error = await db.execute(sql.raw(statement)).catch((e: unknown) => e);
      return sqlState(error) === '42501' ? 'denied' : error;
    };
    const updated = await probe(`UPDATE ${table} SET ${spec.touch}`);
    const deleted =
      spec.noDelete === true
        ? await db
            .execute(sql.raw(`DELETE FROM ${table}`))
            .then(() => 'allowed')
            .catch((e: unknown) => (sqlState(e) === '42501' ? 'denied' : e))
        : await probe(`DELETE FROM ${table}`);
    expect([updated, deleted]).toEqual([none, noDelete]);
  });
});

describe('user context (withUser: "my businesses")', () => {
  let ana: UserId;
  let ben: UserId;

  beforeAll(async () => {
    // Ana owns A and is staff at B; Ben is staff at A only.
    ana = await insertUser(db, 'Ana');
    ben = await insertUser(db, 'Ben');
    await withTenant(db, tenantA, (tx) => addMembership(tx, { userId: ana, role: 'owner' }));
    await withTenant(db, tenantB, (tx) => addMembership(tx, { userId: ana, role: 'staff' }));
    await withTenant(db, tenantA, (tx) => addMembership(tx, { userId: ben, role: 'staff' }));
  });

  it("lists exactly the user's businesses with their role", async () => {
    const anas = await withUser(db, ana, listUserBusinesses);
    expect(anas.map((b) => [b.tenantId, b.role])).toEqual([
      [tenantA, 'owner'],
      [tenantB, 'staff'],
    ]);
    const bens = await withUser(db, ben, listUserBusinesses);
    expect(bens.map((b) => [b.tenantId, b.role])).toEqual([[tenantA, 'staff']]);
  });

  it("sees only the user's own memberships, not their colleagues'", async () => {
    const { rows: seen } = await withUser(db, ben, (tx) =>
      tx.execute<{ user_id: string }>(sql`SELECT user_id::text FROM memberships`),
    );
    expect(seen).toEqual([{ user_id: ben }]);
  });

  it('sees no tenant the user is not a member of', async () => {
    const { rows: seen } = await withUser(db, ben, (tx) =>
      tx.execute<{ id: string }>(sql`SELECT id::text FROM tenants`),
    );
    expect(seen).toEqual([{ id: tenantA }]);
  });

  it('sees nothing for a user without memberships', async () => {
    const loner = await insertUser(db, 'Loner');
    await expect(withUser(db, loner, listUserBusinesses)).resolves.toEqual([]);
  });

  it.each([
    [
      'insert a membership',
      (user: UserId) => `INSERT INTO memberships (id, tenant_id, user_id, role)
       VALUES ('${newId()}', (SELECT tenant_id FROM memberships LIMIT 1), '${user}', 'owner')`,
    ],
    ['update a membership', () => "UPDATE memberships SET role = 'owner'"],
    ['delete a membership', () => 'DELETE FROM memberships'],
    ['rename a business', () => "UPDATE tenants SET name = 'mine'"],
  ])('cannot %s (read-only transaction)', async (_label, statement) => {
    const error = await withUser(db, ben, (tx) => tx.execute(sql.raw(statement(ben)))).catch(
      (e: unknown) => e,
    );
    expect(sqlState(error)).toBe('25006'); // read_only_sql_transaction
  });

  it('cannot write even in a read-write transaction: member_read is SELECT only', async () => {
    const { updated, deleted } = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.user_id', ${ben}, true)`);
      return {
        updated: (await tx.execute(sql`UPDATE memberships SET role = 'owner'`)).rowCount,
        deleted: (await tx.execute(sql`DELETE FROM tenants`)).rowCount,
      };
    });
    expect([updated, deleted]).toEqual([0, 0]);
  });

  it("does not widen a tenant transaction: with a tenant set, the user's other businesses stay hidden", async () => {
    const { tenantIds, memberIds } = await withTenant(db, tenantB, async (tx) => {
      // Ana belongs to A as well; setting her as the user must not reveal A inside B.
      await tx.execute(sql`SELECT set_config('app.user_id', ${ana}, true)`);
      const t = await tx.execute<{ id: string }>(sql`SELECT id::text FROM tenants`);
      const m = await tx.execute<{ tenant_id: string }>(
        sql`SELECT DISTINCT tenant_id::text FROM memberships`,
      );
      return { tenantIds: t.rows.map((r) => r.id), memberIds: m.rows.map((r) => r.tenant_id) };
    });
    expect(tenantIds).toEqual([tenantB]);
    expect(memberIds).toEqual([tenantB]);
  });

  it('does not outlive the transaction on a pooled connection', async () => {
    const single = createDatabase({ url: database.appUrl, maxConnections: 1 });
    try {
      await expect(withUser(single.db, ana, listUserBusinesses)).resolves.toHaveLength(2);
      const after = await single.db.execute(
        sql`SELECT current_user_id() AS id, count(*)::int AS n FROM memberships`,
      );
      expect(after.rows).toEqual([{ id: null, n: 0 }]);
    } finally {
      await single.close();
    }
  });

  it('fails closed on a malformed user setting', async () => {
    const error = await db
      .transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.user_id', 'garbage', true)`);
        await tx.execute(sql`SELECT * FROM memberships`);
      })
      .catch((e: unknown) => e);
    expect(sqlState(error)).toBe('22P02');
  });
});

describe('invite lookup (withInviteTenant: an invitee who is not a member yet)', () => {
  function inviteIds(): { a: string; b: string } {
    const ids = rows['invites'];
    if (ids === undefined) throw new Error('no seed invites');
    return ids;
  }

  async function hashOf(tenant: TenantId, id: string): Promise<string> {
    const { rows: found } = await inTenant<{ token_hash: string }>(
      tenant,
      `SELECT token_hash FROM invites WHERE id = '${id}'`,
    );
    return String(found[0]?.token_hash);
  }

  /** Raw SQL with only the token hash set (no tenant), in one transaction. */
  function withHash<T extends Record<string, unknown>>(hash: string, statement: string) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.invite_token_hash', ${hash}, true)`);
      return tx.execute<T>(sql.raw(statement));
    });
  }

  it("shows exactly the invite whose token hash is presented, bound to that invite's tenant", async () => {
    const invites = inviteIds();
    const seen = await withInviteTenant(
      db,
      await hashOf(tenantB, invites.b),
      async (tx, invite) => {
        const { rows: tenant } = await tx.execute<{ id: string }>(
          sql`SELECT current_tenant_id()::text AS id`,
        );
        return { invite: invite.id, tenant: tenant[0]?.id };
      },
    );
    expect(seen).toEqual({ invite: invites.b, tenant: tenantB });
  });

  it('shows nothing for a hash no invite has', async () => {
    let called = false;
    const result = await withInviteTenant(db, randomBytes(32).toString('hex'), () => {
      called = true;
      return Promise.resolve('reached');
    });
    expect([result, called]).toEqual([undefined, false]);
  });

  it('a hash reveals no other invite, tenant or membership', async () => {
    const hash = await hashOf(tenantA, inviteIds().a);
    const { rows: seen } = await withHash<{ id: string }>(hash, 'SELECT id::text FROM invites');
    expect(seen).toEqual([{ id: inviteIds().a }]);
    for (const table of ['tenants', 'memberships', 'audit_log', 'usage_meters']) {
      const { rows: other } = await withHash(hash, `SELECT * FROM ${table}`);
      expect(other, table).toEqual([]);
    }
  });

  it('a hash cannot change the invite: invite_lookup is SELECT only', async () => {
    const hash = await hashOf(tenantA, inviteIds().a);
    const updated = await withHash(hash, "UPDATE invites SET role = 'owner'");
    const deleted = await withHash(hash, 'DELETE FROM invites');
    expect([updated.rowCount, deleted.rowCount]).toEqual([0, 0]);
  });

  it("does not widen a tenant transaction: another tenant's invite stays hidden", async () => {
    const hash = await hashOf(tenantB, inviteIds().b);
    const { rows: seen } = await withTenant(db, tenantA, async (tx) => {
      await tx.execute(sql`SELECT set_config('app.invite_token_hash', ${hash}, true)`);
      return tx.execute(sql`SELECT * FROM invites WHERE token_hash = ${hash}`);
    });
    expect(seen).toEqual([]);
  });

  it('a read-only lookup cannot write', async () => {
    const hash = await hashOf(tenantA, inviteIds().a);
    const error = await withInviteTenant(
      db,
      hash,
      (tx) => tx.execute(sql`UPDATE invites SET role = role`),
      { readOnly: true },
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('25006');
  });

  it('does not outlive the transaction on a pooled connection', async () => {
    const single = createDatabase({ url: database.appUrl, maxConnections: 1 });
    try {
      const hash = await hashOf(tenantA, inviteIds().a);
      await withInviteTenant(single.db, hash, () => Promise.resolve());
      const after = await single.db.execute(
        sql`SELECT current_invite_token_hash() AS hash, count(*)::int AS n FROM invites`,
      );
      expect(after.rows).toEqual([{ hash: null, n: 0 }]);
    } finally {
      await single.close();
    }
  });
});

describe('public lookup (withPublicTenant: the booking page finds its business by slug)', () => {
  /** Raw SQL with only the slug set (no tenant), in one transaction. */
  function withSlug<T extends Record<string, unknown>>(slug: string, statement: string) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.public_slug', ${slug}, true)`);
      return tx.execute<T>(sql.raw(statement));
    });
  }

  it('binds the transaction to the business with that slug, without a user', async () => {
    const seen = await withPublicTenant(db, 'tenant-b', async (tx, tenant) => {
      const { rows: context } = await tx.execute<{ tenant: string; user: string | null }>(
        sql`SELECT current_tenant_id()::text AS tenant, current_user_id()::text AS user`,
      );
      return { id: tenant.id, ...context[0] };
    });
    expect(seen).toEqual({ id: tenantB, tenant: tenantB, user: null });
  });

  it('finds nothing for a slug no business has', async () => {
    let called = false;
    const result = await withPublicTenant(db, 'no-such-business', () => {
      called = true;
      return Promise.resolve('reached');
    });
    expect([result, called]).toEqual([undefined, false]);
  });

  it('a slug shows only its own business row, and no other table', async () => {
    const { rows: seen } = await withSlug<{ id: string }>(
      'tenant-a',
      'SELECT id::text FROM tenants',
    );
    expect(seen).toEqual([{ id: tenantA }]);
    for (const table of Object.keys(TENANT_TABLES).filter((t) => t !== 'tenants')) {
      const { rows: other } = await withSlug('tenant-a', `SELECT * FROM ${table}`);
      expect(other, table).toEqual([]);
    }
  });

  it('a slug cannot change the business: public_lookup is SELECT only', async () => {
    const updated = await withSlug('tenant-a', "UPDATE tenants SET name = 'taken'");
    const deleted = await withSlug('tenant-a', 'DELETE FROM tenants');
    expect([updated.rowCount, deleted.rowCount]).toEqual([0, 0]);
  });

  it("does not widen a tenant transaction: another business's row stays hidden", async () => {
    const { rows: seen } = await withTenant(db, tenantA, async (tx) => {
      await tx.execute(sql`SELECT set_config('app.public_slug', 'tenant-b', true)`);
      return tx.execute(sql`SELECT id FROM tenants WHERE slug = 'tenant-b'`);
    });
    expect(seen).toEqual([]);
  });

  it("a member transaction cannot read booking requests, even an owner's", async () => {
    const user = await insertUser(db);
    await withTenant(db, tenantA, (tx) => addMembership(tx, { userId: user, role: 'owner' }));
    const { rows: seen } = await withTenant(db, tenantA, async (tx) => {
      await tx.execute(sql`SELECT set_config('app.user_id', ${user}, true)`);
      return tx.execute(sql`SELECT id FROM booking_verifications`);
    });
    expect(seen).toEqual([]);
  });

  it('a read-only lookup cannot write', async () => {
    const error = await withPublicTenant(
      db,
      'tenant-a',
      (tx) => tx.execute(sql`UPDATE tenants SET name = name`),
      { readOnly: true },
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('25006');
  });

  it('does not outlive the transaction on a pooled connection', async () => {
    const single = createDatabase({ url: database.appUrl, maxConnections: 1 });
    try {
      await withPublicTenant(single.db, 'tenant-a', () => Promise.resolve());
      const after = await single.db.execute(
        sql`SELECT current_public_slug() AS slug, count(*)::int AS n FROM tenants`,
      );
      expect(after.rows).toEqual([{ slug: null, n: 0 }]);
    } finally {
      await single.close();
    }
  });
});

describe('outbox scan (listDueOutboxMessages: the relay finds work across businesses)', () => {
  /** Runs `statement` in a transaction with the scan setting on (and a tenant, if given). */
  async function scanning(statement: string, tenant?: TenantId) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.outbox_scan', 'on', true)`);
      if (tenant !== undefined) {
        await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenant}, true)`);
      }
      return tx.execute(sql.raw(statement));
    });
  }

  it("lists both businesses' due messages, ids only", async () => {
    const due = await listDueOutboxMessages(db, new Date(Date.now() + 60_000), 1000);
    const seeded = rows['outbox_dispatch'];
    expect(due.map((d) => d.messageId)).toEqual(expect.arrayContaining([seeded?.a, seeded?.b]));
    expect(new Set(due.map((d) => d.tenantId))).toEqual(new Set([tenantA, tenantB]));
  });

  it('reaches only the dispatch index, read-only', async () => {
    for (const table of ['outbox_messages', 'tenants', 'bookings', 'clients']) {
      const { rows: seen } = await scanning(`SELECT * FROM ${table}`);
      expect(seen, table).toEqual([]);
    }
    const updated = await scanning('UPDATE outbox_dispatch SET available_at = available_at');
    const deleted = await scanning('DELETE FROM outbox_dispatch');
    expect([updated.rowCount, deleted.rowCount]).toEqual([0, 0]);
  });

  it('does not widen a tenant transaction', async () => {
    const { rows: seen } = await scanning(
      'SELECT tenant_id::text AS owner FROM outbox_dispatch',
      tenantA,
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((row) => row['owner'] === tenantA)).toBe(true);
  });

  it('ends with the transaction', async () => {
    await scanning('SELECT 1');
    const { rows: after } = await db.transaction((tx) =>
      tx.execute(sql`SELECT * FROM outbox_dispatch`),
    );
    expect(after).toEqual([]);
  });
});

describe.each([
  ['reminders', 'booking_reminders'],
  ['cleanup', 'tenants'],
  ['tasks', 'tasks'],
  ['insights', 'insight_runs'],
  ['waitlist', 'waitlist_matches'],
  ['support', 'support_threads'],
] as const)('job scan %s (withJobScan: the job finds work across businesses)', (job, table) => {
  /** Runs `statement` in a transaction with `app.job_scan` set to `name` (and a tenant). */
  async function scanning(statement: string, options: { name?: string; tenant?: TenantId } = {}) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.job_scan', ${options.name ?? job}, true)`);
      if (options.tenant !== undefined) {
        await tx.execute(sql`SELECT set_config('app.tenant_id', ${options.tenant}, true)`);
      }
      return tx.execute(sql.raw(statement));
    });
  }
  const seeded = () => {
    const ids = rows[table];
    if (ids === undefined) throw new Error(`no seed rows for ${table}`);
    return [ids.a, ids.b];
  };

  it("lists both businesses' rows", async () => {
    const at = new Date('2026-10-19T15:00:00Z');
    const found =
      job === 'reminders'
        ? (await listDueBookingReminders(db, at, 1000)).map((due) => due.bookingId)
        : job === 'tasks'
          ? (await listDueTasks(db, at, 1000)).map((due) => due.taskId)
          : job === 'insights'
            ? (await listDueInsightRuns(db, at, 3_600_000, 1000)).map((due) => due.runId)
            : job === 'waitlist'
              ? (await listDueWaitlistMatches(db, new Date(), 1000)).map((due) => due.matchId)
              : job === 'support'
                ? (
                    await listDueSupportThreads(db, {
                      overdueBefore: new Date('2999-01-01T00:00:00Z'),
                      quietBefore: new Date('2999-01-01T00:00:00Z'),
                      limit: 1000,
                    })
                  ).map((due) => due.threadId)
                : await listTenantIdsForCleanup(db, null, 1000);
    expect(found).toEqual(expect.arrayContaining(seeded()));
  });

  it(`reaches only ${table}, read-only`, async () => {
    for (const other of [
      'booking_reminders',
      'tasks',
      'insight_runs',
      'insight_requests',
      'feed_items',
      'waitlist_matches',
      'waitlist_offers',
      'waitlist_entries',
      'tenants',
      'bookings',
      'clients',
      'outbox_dispatch',
      'support_threads',
      'support_messages',
    ]) {
      // The insights job reads its two tables: runs, and the requests that make one due; the
      // support job reads threads and their messages (how long each has waited).
      if (
        other === table ||
        (job === 'insights' && other === 'insight_requests') ||
        (job === 'support' && other === 'support_messages')
      ) {
        continue;
      }
      const { rows: seen } = await scanning(`SELECT * FROM ${other}`);
      expect(seen, other).toEqual([]);
    }
    const touch = TENANT_TABLES[table]?.touch ?? '';
    const updated = await scanning(`UPDATE ${table} SET ${touch}`);
    const deleted = await scanning(`DELETE FROM ${table}`);
    expect([updated.rowCount, deleted.rowCount]).toEqual([0, 0]);
  });

  it('needs its own job name', async () => {
    const otherJob = job === 'reminders' ? 'cleanup' : 'reminders';
    for (const name of [otherJob, '', job.toUpperCase()]) {
      const { rows: seen } = await scanning(`SELECT * FROM ${table}`, { name });
      expect(seen, name).toEqual([]);
    }
  });

  it('does not widen a tenant transaction', async () => {
    const column = TENANT_TABLES[table]?.tenantColumn ?? 'tenant_id';
    const { rows: seen } = await scanning(`SELECT ${column}::text AS owner FROM ${table}`, {
      tenant: tenantA,
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((row) => row['owner'] === tenantA)).toBe(true);
  });

  it('ends with the transaction', async () => {
    await scanning('SELECT 1');
    const { rows: after } = await db.transaction((tx) =>
      tx.execute(sql.raw(`SELECT * FROM ${table}`)),
    );
    expect(after).toEqual([]);
  });
});

describe('tenant context', () => {
  it('does not outlive the transaction on a pooled connection', async () => {
    const single = createDatabase({ url: database.appUrl, maxConnections: 1 });
    try {
      const inside = await withTenant(single.db, tenantA, (tx) =>
        tx.execute(sql`SELECT id FROM tenants`),
      );
      expect(inside.rows).toHaveLength(1);
      // Same (only) connection, after COMMIT: the setting reads '' and must match nothing.
      const after = await single.db.execute(
        sql`SELECT current_tenant_id() AS id, count(*)::int AS n FROM tenants`,
      );
      expect(after.rows).toEqual([{ id: null, n: 0 }]);
      // ...and after a ROLLBACK.
      await withTenant(single.db, tenantA, () => Promise.reject(new Error('rollback'))).catch(
        () => undefined,
      );
      const afterRollback = await single.db.execute(sql`SELECT count(*)::int AS n FROM tenants`);
      expect(afterRollback.rows).toEqual([{ n: 0 }]);
    } finally {
      await single.close();
    }
  });

  it('keeps concurrent transactions apart', async () => {
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, i) => {
        const tenant = i % 2 === 0 ? tenantA : tenantB;
        return withTenant(db, tenant, async (tx) => {
          await tx.execute(sql`SELECT pg_sleep(0.01)`);
          const { rows: seen } = await tx.execute<{ id: string }>(
            sql`SELECT id::text FROM tenants`,
          );
          return { tenant, seen: seen.map((row) => row.id) };
        });
      }),
    );
    for (const { tenant, seen } of results) expect(seen).toEqual([tenant]);
  });

  it('fails closed on a malformed tenant setting', async () => {
    const error = await db
      .transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.tenant_id', 'garbage', true)`);
        await tx.execute(sql`SELECT * FROM tenants`);
      })
      .catch((e: unknown) => e);
    expect(sqlState(error)).toBe('22P02'); // invalid_text_representation
  });

  it('ends with the transaction even when SQL inside it switched the setting', async () => {
    // A statement can switch the setting, which is why tenant ids come only from the session
    // and SQL is never built from LLM arguments; the switch still ends with the transaction.
    await withTenant(db, tenantA, async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantB}, true)`);
    });
    const after = await db.execute(sql`SELECT count(*)::int AS n FROM tenants`);
    expect(after.rows).toEqual([{ n: 0 }]);
  });
});

describe('merging and deleting clients (S50, ADR-0051)', () => {
  let owner: UserId;
  let mine: ClientId;
  let theirs: ClientId;
  const asOwner = <T>(work: (tx: TenantTx) => Promise<T>) =>
    withMember(db, { tenantId: tenantA, userId: owner }, work);
  const newClient = (tenant: TenantId, name: string) =>
    withTenant(db, tenant, async (tx) =>
      ClientIdSchema.parse(
        (await insertClient(tx, { name, email: null, phone: null, source: 'team' })).id,
      ),
    );

  beforeAll(async () => {
    owner = await insertUser(db, 'Owner of A');
    await withTenant(db, tenantA, (tx) => addMembership(tx, { userId: owner, role: 'owner' }));
    mine = await newClient(tenantA, 'Mine');
    theirs = await newClient(tenantB, 'Theirs');
  });

  it("another business's client can't be merged in, merged into or deleted", async () => {
    const at = new Date('2099-01-01T00:00:00Z');
    expect(await asOwner((tx) => mergeClientRows(tx, mine, theirs, at))).toBeUndefined();
    expect(await asOwner((tx) => mergeClientRows(tx, theirs, mine, at))).toBeUndefined();
    expect(await asOwner((tx) => deleteClientRow(tx, theirs, at))).toBeUndefined();
    const still = await withTenant(db, tenantB, (tx) => findClient(tx, theirs));
    expect(still).toMatchObject({ name: 'Theirs', deletedAt: null });
    expect(await asOwner((tx) => findClient(tx, mine))).toBeDefined();
  });

  it("the merge and forget functions refuse another business's client", async () => {
    for (const statement of [
      `SELECT client_forget('${theirs}'::uuid)`,
      `SELECT client_merge_episodes('${theirs}'::uuid, '${mine}'::uuid)`,
      `SELECT client_merge_episodes('${mine}'::uuid, '${theirs}'::uuid)`,
    ]) {
      const error = await asOwner((tx) => tx.execute(sql.raw(statement))).catch((e: unknown) => e);
      expect(sqlState(error)).toBe('P0002');
    }
  });

  it('the merge and forget functions refuse a transaction without a member', async () => {
    const error = await inTenant(tenantA, `SELECT client_forget('${mine}'::uuid)`).catch(
      (e: unknown) => e,
    );
    expect(sqlState(error)).toBe('42501');
  });
});

describe('walk-in clients (S50.2, ADR-0052)', () => {
  let staffUser: UserId;
  let staffOfA: StaffMemberId;
  const asStaff = <T>(tenant: TenantId, work: (tx: TenantTx) => Promise<T>) =>
    withMember(db, { tenantId: tenant, userId: staffUser }, work);

  beforeAll(async () => {
    staffUser = await insertUser(db, 'Staff of A');
    staffOfA = await withTenant(db, tenantA, async (tx) => {
      const membership = await addMembership(tx, { userId: staffUser, role: 'staff' });
      const staff = await insertStaffMember(tx, {
        displayName: 'Walk-in staff',
        color: '#2a7230',
        active: true,
        membershipId: membership.id,
      });
      return StaffMemberIdSchema.parse(staff.id);
    });
  });

  it("a staff member of one business can't add a walk-in to another", async () => {
    const error = await asStaff(tenantB, (tx) =>
      insertWalkInClient(tx, { name: 'Across', email: null, phone: null }),
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('42501');
  });

  it('the walk-in function refuses a transaction without a member', async () => {
    const error = await inTenant(
      tenantA,
      `SELECT create_walk_in_client('${newId()}'::uuid, 'No member', NULL, NULL)`,
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('42501');
  });

  it("a walk-in belongs to the staff member's business only, and needs its own booking there", async () => {
    const id = await asStaff(tenantA, async (tx) => {
      const added = await insertWalkInClient(tx, { name: 'Walk A', email: null, phone: null });
      await insertBooking(tx, {
        clientId: added,
        serviceId: await withTenant(db, tenantA, seedService),
        staffMemberId: staffOfA,
        startsAt: new Date('2099-06-01T14:00:00Z'),
        endsAt: new Date('2099-06-01T14:45:00Z'),
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        priceFromCents: null,
        priceToCents: null,
        source: 'team',
        overridden: true,
        idempotencyKey: null,
        createdBy: staffUser,
      });
      return added;
    });
    expect(await withTenant(db, tenantB, (tx) => findClient(tx, id))).toBeUndefined();
    expect(await withTenant(db, tenantA, (tx) => findClient(tx, id))).toMatchObject({
      name: 'Walk A',
    });
    // A booking in another business doesn't count: the client is refused at commit.
    const unbooked = await asStaff(tenantA, (tx) =>
      insertWalkInClient(tx, { name: 'Walk unbooked', email: null, phone: null }),
    ).catch((e: unknown) => e);
    expect(sqlState(unbooked)).toBe('23514');
  });
});
