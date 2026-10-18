import { z } from 'zod';
import type { MembershipRole } from './tenancy.js';

/**
 * What a member may do in their business. Which role may do what, and on whose records, is the
 * permission matrix in `@pepper/core` (ADR-0013); domain services check it for the UI and the
 * AI alike. Actions for later phases are listed now so the matrix is reviewed as a whole.
 */
export const PermissionSchema = z.enum([
  // The business itself.
  'business.read',
  'business.update',
  'business.delete',
  'billing.manage',
  'usage.read',
  // Team.
  'members.read',
  'members.invite',
  'members.manage',
  // Trust.
  'audit.read',
  'autonomy.manage',
  // Settings and integrations (booking page, Google Calendar).
  'settings.manage',
  'integrations.manage',
  // Services menu (Phase 3).
  'services.read',
  'services.manage',
  // Staff who can be booked, their weekly hours and their time off (Phase 3, ADR-0015).
  // Staff members manage their own time off; owners and managers everyone's.
  'staff.read',
  'staff.manage',
  'hours.manage',
  'time_off.manage',
  // Booking rules: notice, how far ahead, slot steps, daily caps, closed days (ADR-0016).
  'rules.read',
  'rules.manage',
  // Calendar and bookings (Phase 3): everyone sees when the team is busy; booking details and
  // changes are scoped to a member's own bookings for staff (AC-W9-1).
  'calendar.read',
  'bookings.read',
  'bookings.manage',
  // Clients and their notes (Phase 3+).
  'clients.read',
  'clients.manage',
  'client_notes.read',
  'client_notes.manage',
]);
export type Permission = z.infer<typeof PermissionSchema>;

/**
 * Roles that must have a second factor (TOTP) before they can work in a business: they see
 * every client and can change how the business runs (ADR-0007, ADR-0013). The api enforces
 * it; the web app uses it to send people to the setup page first.
 */
const ROLES_REQUIRING_MFA: ReadonlySet<MembershipRole> = new Set(['owner', 'manager']);

export function roleRequiresMfa(role: MembershipRole): boolean {
  return ROLES_REQUIRING_MFA.has(role);
}
