import { type ImportBatchId } from '@pepper/contracts';
import {
  BookingOverlapError,
  findCurrentTenant,
  findImportDefaultStaffMemberId,
  insertImportedBookings,
  insertService,
  listClientBookingStarts,
  listOccupancy,
  listServices,
  listStaffMembers,
  ServiceNameTakenError,
  undoImportedBookings,
  type NewImportedBooking,
  type ServiceRow,
  type TenantTx,
} from '@pepper/db';
import { requestInsights } from './insights.js';

// The appointments module's side of a visits import (S49, ADR-0050 §2): what the import needs
// to plan visits (the business's zone, services, staff, busy time and the visits it has) and to
// write them. Written bookings are `source` import with their batch, and nothing else follows:
// no confirmation, no reminder planned, no waitlist matching (AC-W1-24). The insights re-run
// once, when the run finishes. It matches `@pepper/imports`' `VisitBook` by shape: neither
// module imports the other; the api and the worker pass it in.

const key = (name: string) => name.replace(/\s+/g, ' ').trim().toLowerCase();

interface ImportService {
  id: string;
  name: string;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  priceFromCents: number | null;
}

const toService = (row: ServiceRow): ImportService => ({
  id: row.id,
  name: row.name,
  durationMinutes: row.durationMinutes,
  bufferBeforeMinutes: row.bufferBeforeMinutes,
  bufferAfterMinutes: row.bufferAfterMinutes,
  priceFromCents: row.priceFromCents,
});

interface ImportVisit extends Omit<NewImportedBooking, 'status'> {
  status: NewImportedBooking['status'];
}

export const importVisitBook = {
  async context(tx: TenantTx, userId: string | null) {
    const tenant = await findCurrentTenant(tx);
    if (tenant === undefined) throw new Error('No business in this transaction');
    const staff = (await listStaffMembers(tx))
      .filter((member) => member.active)
      .map((member) => ({ id: member.id, name: member.displayName }));
    const defaultId = await findImportDefaultStaffMemberId(tx, userId);
    return {
      timeZone: tenant.timeZone,
      services: (await listServices(tx)).map(toService),
      staff,
      defaultStaff: staff.find((member) => member.id === defaultId) ?? null,
    };
  },

  async busy(tx: TenantTx, from: Date, to: Date) {
    const rows = await listOccupancy(tx, { from, to });
    return rows.map((row) => ({
      staffMemberId: row.staffMemberId,
      from: row.occupiedFrom,
      to: row.occupiedTo,
    }));
  },

  visitStarts(tx: TenantTx, clientIds: readonly string[], from: Date, to: Date) {
    return listClientBookingStarts(tx, clientIds, from, to);
  },

  /** Hidden services (never on the booking page) for names the business doesn't have. */
  async addHiddenServices(
    tx: TenantTx,
    wanted: readonly { name: string; durationMinutes: number }[],
  ): Promise<ImportService[]> {
    const out: ImportService[] = [];
    for (const { name, durationMinutes } of wanted) {
      const found = async () =>
        (await listServices(tx)).find((service) => key(service.name) === key(name));
      const existing = await found();
      if (existing !== undefined) {
        out.push(toService(existing));
        continue;
      }
      try {
        const row = await tx.transaction((savepoint) =>
          insertService(savepoint, {
            name: name.replace(/\s+/g, ' ').trim().slice(0, 120),
            category: null,
            durationMinutes: Math.min(720, Math.max(5, durationMinutes)),
            bufferBeforeMinutes: 0,
            bufferAfterMinutes: 0,
            priceFromCents: null,
            priceToCents: null,
            active: false,
          }),
        );
        out.push(toService(row));
      } catch (error) {
        // Made by someone else meanwhile: use theirs.
        if (!(error instanceof ServiceNameTakenError)) throw error;
        const made = await found();
        if (made === undefined) throw error;
        out.push(toService(made));
      }
    }
    return out;
  },

  /**
   * Writes the visits: history in bulk (it occupies no time), each upcoming one in its own
   * savepoint, so one whose time was taken since the plan comes back as a conflict.
   */
  async writeVisits(
    tx: TenantTx,
    batchId: ImportBatchId,
    visits: readonly ImportVisit[],
  ): Promise<{ conflicts: string[] }> {
    const past = visits.filter((visit) => visit.status !== 'confirmed');
    const upcoming = visits.filter((visit) => visit.status === 'confirmed');
    await insertImportedBookings(tx, batchId, past);
    const conflicts: string[] = [];
    for (const visit of upcoming) {
      try {
        await tx.transaction((savepoint) => insertImportedBookings(savepoint, batchId, [visit]));
      } catch (error) {
        if (!(error instanceof BookingOverlapError)) throw error;
        conflicts.push(visit.id);
      }
    }
    return { conflicts };
  },

  /** The insights see the new history once (rebooking due, gaps), not once per visit. */
  async finished(tx: TenantTx): Promise<void> {
    await requestInsights(tx);
  },

  undo(tx: TenantTx, batchId: ImportBatchId) {
    return undoImportedBookings(tx, batchId);
  },
};
