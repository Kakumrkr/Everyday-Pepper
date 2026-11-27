import { asc, isNull } from 'drizzle-orm';
import {
  bookingFees,
  bookingPayments,
  bookingRules,
  bookings,
  clients,
  memoryFacts,
  services,
  staffMembers,
  staffServices,
  tenants,
  timeOff,
  visitRisks,
  waitlistEntries,
  workingHours,
} from '../schema.js';
import type { TenantTx } from '../tenant.js';
import { listSupportScreenshotsForExport } from './support-screenshots.js';
import { findPaymentAccount } from './payments.js';
import { listSmsConsentsForExport } from './sms.js';
import { listSupportForExport } from './support.js';

// A business's export (S51, ADR-0053, AC-W1-37): everything the owner can take with them, read
// in the business's own transaction (RLS keeps it to its rows). Each table is read with the
// columns that mean something to the owner: never a token hash, an idempotency key or who in
// the team typed it. `BUSINESS_EXPORT_TABLES` names every tenant table, exported or why not;
// an integration test fails for a new table that is in neither.

/**
 * Every tenant-owned table: `true` when the export holds it, else why it doesn't. A business
 * that leaves takes its records; Pepper's own workings, sign-in and delivery state stay.
 */
export const BUSINESS_EXPORT_TABLES: Readonly<Record<string, true | string>> = {
  tenants: true,
  booking_rules: true,
  services: true,
  staff_members: true,
  staff_services: true,
  working_hours: true,
  time_off: true,
  clients: true,
  bookings: true,
  visit_risks: true,
  waitlist_entries: true,
  memory_facts: true,
  memberships: 'who signs in: accounts, not business records',
  invites: 'open sign-in invitations',
  audit_log: 'Pepper’s record of changes, kept for the business’s safety',
  usage_meters: 'Pepper’s own usage counters',
  booking_occupancy: 'derived from bookings (the time each one holds)',
  booking_series: 'how a series of recurring visits was asked for (S72); each visit is in bookings',
  waitlist_matches: 'Pepper’s working state for waitlist offers',
  waitlist_offers: 'offers sent; the outcome is on the waitlist entry and the booking',
  booking_verifications: 'one-time sign-in codes for the booking page',
  remembered_devices: 'booking-page device tokens',
  booking_funnel_events: 'anonymous booking-page step counts',
  business_photos: 'the images are the owner’s own uploads (a later export, ADR-0053)',
  import_batches: 'earlier imports’ working state',
  import_rows: 'earlier imports’ working state',
  inbound_emails:
    'emails at the inbound webhook (S59.3, S59.3.2): delivery records; a landed email is its support message or request',
  client_import_refs: 'other tools’ ids for imported clients',
  outbox_messages: 'emails waiting to go out',
  outbox_dispatch: 'email delivery state',
  booking_reminders: 'reminder delivery state',
  tasks: 'the team’s to-dos (a later export, ADR-0053)',
  push_subscriptions: 'this device’s notification addresses',
  autonomy_settings: 'Pepper’s settings, not business records',
  ai_action_proposals: 'Pepper’s working state',
  ai_action_executions: 'Pepper’s receipts, kept for the business’s safety',
  conversations: 'chats with Pepper, deleted after 90 days',
  conversation_turns: 'chats with Pepper, deleted after 90 days',
  conversation_messages: 'chats with Pepper, deleted after 90 days',
  memory_episodes: 'Pepper’s working state',
  feed_items: 'Pepper’s suggestions',
  insight_runs: 'Pepper’s working state',
  insight_requests: 'Pepper’s working state',
  activation_events: 'Pepper’s record of a business’s first steps',
  support_threads: true,
  support_messages: true,
  support_reads: 'when each member last opened a support request',
  support_screenshots: true,
  sms_consents: true,
  payment_accounts: true,
  booking_payments: true,
  booking_fees: true,
  payment_webhook_events:
    'Stripe’s notices to Pepper (S65): delivery records, deleted after 30 days',
  sms_deliveries: 'text delivery state',
  booking_texts: 'text delivery state',
  booking_manage_links: 'reschedule links in reminders (hashes only)',
  approval_texts: 'cards texted to members for an OK (code hashes only)',
  calendar_connections:
    'staff members’ Google Calendar links (S70): sealed sign-in tokens, never exported',
  calendar_connect_states: 'one-time Google sign-in states (10 minutes; hashes and sealed values)',
  calendar_busy_blocks: 'busy times copied from Google Calendar, which still holds them',
  calendar_event_syncs:
    'which bookings are written to Google Calendar (S71): ids and versions only',
};

/** What a business's export holds, as read. */
export interface BusinessExportData {
  business: {
    name: string;
    slug: string;
    timeZone: string;
    locale: string;
    templateId: string | null;
    brandColor: string | null;
    phone: string | null;
    publicAddress: string | null;
    cancellationPolicy: string | null;
    /** The deposit refund window (S66) and who pays one (S67). */
    depositRefundHours: number;
    depositAudience: string;
    /** The cancellation policy's costs (S67.2); `null`: no policy. */
    cancellationFees: unknown;
    mailingAddress: string | null;
    reviewUrl: string | null;
    createdAt: Date;
  };
  rules: { staffMemberId: string | null; type: string; version: number; params: unknown }[];
  services: {
    id: string;
    name: string;
    category: string | null;
    durationMinutes: number;
    bufferBeforeMinutes: number;
    bufferAfterMinutes: number;
    priceFromCents: number | null;
    priceToCents: number | null;
    rebookAfterDays: number | null;
    active: boolean;
  }[];
  staff: { id: string; displayName: string; color: string; active: boolean }[];
  staffServices: { staffMemberId: string; serviceId: string }[];
  workingHours: {
    staffMemberId: string;
    weekday: number;
    startMinute: number;
    endMinute: number;
  }[];
  timeOff: { staffMemberId: string; startsAt: Date; endsAt: Date }[];
  /** Not deleted ones: a deleted client was forgotten (ADR-0051). */
  clients: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    source: string;
    emailOptOutAt: Date | null;
    tags: string[];
    birthdayMonth: number | null;
    birthdayDay: number | null;
    birthdayYear: number | null;
    createdAt: Date;
  }[];
  bookings: {
    id: string;
    clientId: string;
    serviceId: string;
    staffMemberId: string;
    startsAt: Date;
    endsAt: Date;
    bufferBeforeMinutes: number;
    bufferAfterMinutes: number;
    priceFromCents: number | null;
    priceToCents: number | null;
    status: string;
    source: string;
    createdAt: Date;
    /** When it was cancelled (S77); null while it isn't. */
    cancelledAt: Date | null;
    /** Who cancelled it (S78): `client`, `business`, or null (not cancelled, or unknown). */
    cancelledBy: string | null;
    /** When and how the client confirmed it (S62, S78), and when they were last asked (S78). */
    clientConfirmedAt: Date | null;
    clientConfirmedVia: string | null;
    confirmAskedAt: Date | null;
    /** When the holdback kept it from its early ask (S78.3); null: not held back. */
    confirmHeldBackAt: Date | null;
  }[];
  waitlist: {
    id: string;
    clientId: string;
    serviceId: string;
    staffMemberId: string | null;
    windows: unknown;
    status: string;
    expiresAt: Date;
    bookingId: string | null;
    createdAt: Date;
  }[];
  facts: {
    id: string;
    subjectType: string;
    clientId: string | null;
    staffMemberId: string | null;
    serviceId: string | null;
    bookingId: string | null;
    key: string;
    value: string;
    sensitive: boolean;
    status: string;
    source: string;
    createdAt: Date;
    updatedAt: Date;
  }[];
  /** Requests to the Pepper team (S59, AC-X-18) and their messages, the team's included. */
  support: {
    threads: { id: string; reference: string; kind: string; status: string; createdAt: Date }[];
    messages: {
      id: string;
      threadId: string;
      authorKind: string;
      body: string;
      /** `app` or `email` (S59.3). */
      channel: string;
      createdAt: Date;
    }[];
    /** The screenshots sent with them (S59.2.3, AC-X-31): the images are read from storage. */
    screenshots: { id: string; messageId: string; widths: number[] }[];
  };
  /** Consents to the business's texts (S61, ADR-0065 §7): its TCPA records, revoked ones too. */
  smsConsents: {
    id: string;
    phone: string;
    source: string;
    clientId: string | null;
    wordingVersion: string;
    /** The words as shown when it was given. */
    shownText: string;
    givenAt: Date;
    revokedAt: Date | null;
  }[];
  /**
   * The business's Stripe account (S65, ADR-0067 §10): which one and where it stood; `null`
   * without one. What Stripe holds (bank, identity) is the owner's at Stripe, not here.
   */
  payments: {
    provider: string;
    accountId: string;
    status: string;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    connectedAt: Date;
    disconnectedAt: Date | null;
  } | null;
  /** Deposits and cards taken on the booking page (S66, ADR-0068 §6): Stripe's ids, no card. */
  deposits: {
    bookingId: string | null;
    kind: string;
    amountCents: number;
    refundHours: number;
    status: string;
    stripePayment: string;
    createdAt: Date;
    settledAt: Date | null;
  }[];
  /**
   * No-show fees the owner approved (S68, AC-X-142): the dispute record (the sentence the client
   * was shown, when they agreed, who approved and when), Stripe's ids, no card.
   */
  noShowFees: {
    bookingId: string;
    amountCents: number;
    policySentence: string;
    agreedAt: Date;
    approvedBy: string;
    approvedAt: Date;
    status: string;
    failureCode: string | null;
    stripePayment: string | null;
    stripeRefund: string | null;
    chargedAt: Date | null;
  }[];
  /** Upcoming visits' risk bands and their reasons (S77, ADR-0071): counts and days only. */
  visitRisks: {
    bookingId: string;
    band: string;
    points: number;
    reasons: unknown;
    computedAt: Date;
  }[];
}

/**
 * Reads the business's export. The caller opens the transaction as the business's owner, so
 * staff scoping never trims it (only the owner may export).
 */
export async function readBusinessExport(tx: TenantTx): Promise<BusinessExportData> {
  // One query after another: a transaction's queries share one connection.
  const [business] = await tx
    .select({
      name: tenants.name,
      slug: tenants.slug,
      timeZone: tenants.timeZone,
      locale: tenants.locale,
      templateId: tenants.templateId,
      brandColor: tenants.brandColor,
      phone: tenants.phone,
      publicAddress: tenants.publicAddress,
      cancellationPolicy: tenants.cancellationPolicy,
      depositRefundHours: tenants.depositRefundHours,
      depositAudience: tenants.depositAudience,
      cancellationFees: tenants.cancellationFees,
      mailingAddress: tenants.mailingAddress,
      reviewUrl: tenants.reviewUrl,
      createdAt: tenants.createdAt,
    })
    .from(tenants);
  if (business === undefined) throw new Error('The business is not visible to this transaction');
  const rules = await tx
    .select({
      staffMemberId: bookingRules.staffMemberId,
      type: bookingRules.type,
      version: bookingRules.version,
      params: bookingRules.params,
    })
    .from(bookingRules)
    .orderBy(asc(bookingRules.createdAt), asc(bookingRules.id));
  const serviceRows = await tx
    .select({
      id: services.id,
      name: services.name,
      category: services.category,
      durationMinutes: services.durationMinutes,
      bufferBeforeMinutes: services.bufferBeforeMinutes,
      bufferAfterMinutes: services.bufferAfterMinutes,
      priceFromCents: services.priceFromCents,
      priceToCents: services.priceToCents,
      rebookAfterDays: services.rebookAfterDays,
      active: services.active,
    })
    .from(services)
    .orderBy(asc(services.name), asc(services.id));
  const staff = await tx
    .select({
      id: staffMembers.id,
      displayName: staffMembers.displayName,
      color: staffMembers.color,
      active: staffMembers.active,
    })
    .from(staffMembers)
    .orderBy(asc(staffMembers.createdAt), asc(staffMembers.id));
  const offers = await tx
    .select({ staffMemberId: staffServices.staffMemberId, serviceId: staffServices.serviceId })
    .from(staffServices)
    .orderBy(asc(staffServices.staffMemberId), asc(staffServices.serviceId));
  const hours = await tx
    .select({
      staffMemberId: workingHours.staffMemberId,
      weekday: workingHours.weekday,
      startMinute: workingHours.startMinute,
      endMinute: workingHours.endMinute,
    })
    .from(workingHours)
    .orderBy(
      asc(workingHours.staffMemberId),
      asc(workingHours.weekday),
      asc(workingHours.startMinute),
    );
  const away = await tx
    .select({
      staffMemberId: timeOff.staffMemberId,
      startsAt: timeOff.startsAt,
      endsAt: timeOff.endsAt,
    })
    .from(timeOff)
    .orderBy(asc(timeOff.startsAt), asc(timeOff.id));
  const clientRows = await tx
    .select({
      id: clients.id,
      name: clients.name,
      email: clients.email,
      phone: clients.phone,
      source: clients.source,
      emailOptOutAt: clients.emailOptOutAt,
      tags: clients.tags,
      birthdayMonth: clients.birthdayMonth,
      birthdayDay: clients.birthdayDay,
      birthdayYear: clients.birthdayYear,
      createdAt: clients.createdAt,
    })
    .from(clients)
    .where(isNull(clients.deletedAt))
    .orderBy(asc(clients.createdAt), asc(clients.id));
  const bookingRows = await tx
    .select({
      id: bookings.id,
      clientId: bookings.clientId,
      serviceId: bookings.serviceId,
      staffMemberId: bookings.staffMemberId,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      bufferBeforeMinutes: bookings.bufferBeforeMinutes,
      bufferAfterMinutes: bookings.bufferAfterMinutes,
      priceFromCents: bookings.priceFromCents,
      priceToCents: bookings.priceToCents,
      status: bookings.status,
      source: bookings.source,
      createdAt: bookings.createdAt,
      cancelledAt: bookings.cancelledAt,
      cancelledBy: bookings.cancelledBy,
      clientConfirmedAt: bookings.clientConfirmedAt,
      clientConfirmedVia: bookings.clientConfirmedVia,
      confirmAskedAt: bookings.confirmAskedAt,
      confirmHeldBackAt: bookings.confirmHeldBackAt,
    })
    .from(bookings)
    .orderBy(asc(bookings.startsAt), asc(bookings.id));
  const waitlist = await tx
    .select({
      id: waitlistEntries.id,
      clientId: waitlistEntries.clientId,
      serviceId: waitlistEntries.serviceId,
      staffMemberId: waitlistEntries.staffMemberId,
      windows: waitlistEntries.windows,
      status: waitlistEntries.status,
      expiresAt: waitlistEntries.expiresAt,
      bookingId: waitlistEntries.bookingId,
      createdAt: waitlistEntries.createdAt,
    })
    .from(waitlistEntries)
    .orderBy(asc(waitlistEntries.createdAt), asc(waitlistEntries.id));
  const facts = await tx
    .select({
      id: memoryFacts.id,
      subjectType: memoryFacts.subjectType,
      clientId: memoryFacts.clientId,
      staffMemberId: memoryFacts.staffMemberId,
      serviceId: memoryFacts.serviceId,
      bookingId: memoryFacts.bookingId,
      key: memoryFacts.key,
      value: memoryFacts.value,
      sensitive: memoryFacts.sensitive,
      status: memoryFacts.status,
      source: memoryFacts.source,
      createdAt: memoryFacts.createdAt,
      updatedAt: memoryFacts.updatedAt,
    })
    .from(memoryFacts)
    .orderBy(asc(memoryFacts.createdAt), asc(memoryFacts.id));
  return {
    business,
    rules,
    services: serviceRows,
    staff,
    staffServices: offers,
    workingHours: hours,
    timeOff: away,
    clients: clientRows,
    bookings: bookingRows,
    waitlist,
    facts,
    support: {
      ...(await listSupportForExport(tx)),
      screenshots: (await listSupportScreenshotsForExport(tx)).flatMap((row) =>
        row.messageId === null
          ? []
          : [{ id: row.id, messageId: row.messageId, widths: row.widths }],
      ),
    },
    smsConsents: await listSmsConsentsForExport(tx),
    payments: await paymentsForExport(tx),
    deposits: (await tx.select().from(bookingPayments).orderBy(asc(bookingPayments.createdAt))).map(
      (row) => ({
        bookingId: row.bookingId,
        kind: row.kind,
        amountCents: row.amountCents,
        refundHours: row.refundHours,
        status: row.status,
        stripePayment: row.intentId,
        createdAt: row.createdAt,
        settledAt: row.settledAt,
      }),
    ),
    noShowFees: (await tx.select().from(bookingFees).orderBy(asc(bookingFees.createdAt))).map(
      (row) => ({
        bookingId: row.bookingId,
        amountCents: row.amountCents,
        policySentence: row.policySentence,
        agreedAt: row.agreedAt,
        approvedBy: row.approvedBy,
        approvedAt: row.approvedAt,
        status: row.status,
        failureCode: row.failureCode,
        stripePayment: row.intentId,
        stripeRefund: row.refundId,
        chargedAt: row.chargedAt,
      }),
    ),
    visitRisks: await tx
      .select({
        bookingId: visitRisks.bookingId,
        band: visitRisks.band,
        points: visitRisks.points,
        reasons: visitRisks.reasons,
        computedAt: visitRisks.computedAt,
      })
      .from(visitRisks)
      .orderBy(asc(visitRisks.bookingId)),
  };
}

async function paymentsForExport(tx: TenantTx): Promise<BusinessExportData['payments']> {
  const row = await findPaymentAccount(tx);
  if (row === undefined) return null;
  return {
    provider: row.provider,
    accountId: row.providerAccountId,
    status: row.status,
    chargesEnabled: row.chargesEnabled,
    payoutsEnabled: row.payoutsEnabled,
    connectedAt: row.createdAt,
    disconnectedAt: row.deauthorizedAt,
  };
}
