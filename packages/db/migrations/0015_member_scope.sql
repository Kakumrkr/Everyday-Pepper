-- Who the current member is allowed to reach (ADR-0017, AC-W9-1), for the restrictive
-- `member_scope*` policies on clients, bookings, booking_occupancy and waitlist_entries.
-- Tenant-scoped services bind the member's user with `withMember` (app.user_id, transaction-
-- local). Without a user (jobs, the public booking page, migrations' own checks) the policies
-- add nothing to tenant isolation. Both functions run as the caller (SECURITY INVOKER), so
-- memberships and staff_members are read through their own tenant_isolation policies.

-- Whether the current member sees every record of the business: owners and managers, and work
-- that runs without a user. A user who is not a member of the tenant sees nothing beyond their
-- own staff member's rows (none).
CREATE FUNCTION current_member_sees_all() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = public, pg_temp
  AS $$
    SELECT current_user_id() IS NULL OR EXISTS (
      SELECT 1 FROM memberships
       WHERE tenant_id = current_tenant_id()
         AND user_id = current_user_id()
         AND role IN ('owner', 'manager'))
  $$;
--> statement-breakpoint
-- The staff members linked to the current user's membership in the current tenant (at most
-- one). None without a user or a link.
CREATE FUNCTION current_member_staff_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = public, pg_temp
  AS $$
    SELECT s.id
      FROM staff_members s
      JOIN memberships m ON m.tenant_id = s.tenant_id AND m.id = s.membership_id
     WHERE m.tenant_id = current_tenant_id()
       AND m.user_id = current_user_id()
  $$;
