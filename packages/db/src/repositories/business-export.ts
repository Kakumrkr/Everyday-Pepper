import { asc, isNull } from 'drizzle-orm';
import {
  bookingRules,
  bookings,
  clients,
  memoryFacts,
  services,
  staffMembers,
  staffServices,
  tenants,
  timeOff,
  waitlistEntries,
  workingHours,
} from '../schema.js';
import type { TenantTx } from '../tenant.js';

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
  waitlist_entries: true,
  memory_facts: true,
  memberships: 'who signs in: accounts, not business records',
  invites: 'open sign-in invitations',
  audit_log: 'Pepper’s record of changes, kept for the business’s safety',
  usage_meters: 'Pepper’s own usage counters',
  booking_occupancy: 'derived from bookings (the time each one holds)',
  waitlist_matches: 'Pepper’s working state for waitlist offers',
  waitlist_offers: 'offers sent; the outcome is on the waitlist entry and the booking',
  booking_verifications: 'one-time sign-in codes for the booking page',
  remembered_devices: 'booking-page device tokens',
  booking_funnel_events: 'anonymous booking-page step counts',
  business_photos: 'the images are the owner’s own uploads (a later export, ADR-0053)',
  import_batches: 'earlier imports’ working state',
  import_rows: 'earlier imports’ working state',
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
  };
}
