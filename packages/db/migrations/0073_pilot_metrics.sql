ALTER TABLE "operator_access_log" DROP CONSTRAINT "operator_access_log_action_known";--> statement-breakpoint
ALTER TABLE "operator_access_log" ADD CONSTRAINT "operator_access_log_action_known" CHECK ("operator_access_log"."action" IN ('inbox.read', 'thread.read', 'thread.reply', 'thread.note', 'thread.status', 'public.read', 'public.note', 'public.status', 'replies.read', 'replies.write', 'screenshot.read', 'held.read', 'held.accept', 'held.discard', 'mail.resume', 'inbound.counts', 'metrics.read'));--> statement-breakpoint
-- The pilot metrics page (S59.4, ADR-0062, AC-X-47): the platform's numbers from p_since to p_now,
-- for a logged operator only (current_operator_id(), so begin_operator_access wrote the
-- 'metrics.read' row in this transaction). Counts and minutes only: no client, booking,
-- member or business row leaves it. Each business is read as itself (its tenant policies,
-- as operator_business_names does, and named in every query, as the owner may bypass RLS),
-- found through the memberships owner read of 0072; sign-ups are global. Support numbers are read in the operator's own transaction (its policies).
CREATE FUNCTION operator_pilot_metrics(p_since timestamptz, p_now timestamptz) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  tenant text := current_setting('app.tenant_id', true);
  member text := current_setting('app.user_id', true);
  business uuid;
  ids uuid[];
  owners uuid[] := '{}';
  bookable_ats timestamptz[] := '{}';
  first_ats timestamptz[] := '{}';
  owner_of uuid;
  bookable_at timestamptz;
  first_at timestamptz;
  businesses integer := 0;
  bookable_businesses integer := 0;
  funnel record;
  visits record;
  funnel_starts integer := 0;
  funnel_confirmed integer := 0;
  funnel_reached_code integer := 0;
  funnel_left_at_code integer := 0;
  past_bookings integer := 0;
  no_shows integer := 0;
  cancelled_slots integer := 0;
  refilled_slots integer := 0;
  offers_sent integer := 0;
  offers_claimed integer := 0;
  n integer;
  m integer;
  signup record;
BEGIN
  IF (SELECT current_operator_id()) IS NULL THEN
    RAISE EXCEPTION 'not a logged operator transaction' USING ERRCODE = '42501';
  END IF;
  -- No member scope inside: each business as a whole.
  PERFORM set_config('app.user_id', '', true);
  SELECT COALESCE(array_agg(DISTINCT mm.tenant_id), '{}') INTO ids FROM memberships mm;
  FOREACH business IN ARRAY ids LOOP
    PERFORM set_config('app.tenant_id', business::text, true);
    businesses := businesses + 1;
    SELECT a.account_id INTO owner_of FROM activation_events a
     WHERE a.tenant_id = business AND a.kind = 'business_created';
    SELECT a.occurred_at INTO bookable_at FROM activation_events a
     WHERE a.tenant_id = business AND a.kind = 'bookable';
    SELECT a.occurred_at INTO first_at FROM activation_events a
     WHERE a.tenant_id = business AND a.kind = 'first_booking';
    IF bookable_at IS NOT NULL THEN
      bookable_businesses := bookable_businesses + 1;
    END IF;
    IF owner_of IS NOT NULL THEN
      owners := owners || owner_of;
      bookable_ats := bookable_ats || bookable_at;
      first_ats := first_ats || first_at;
    END IF;
    owner_of := NULL;
    bookable_at := NULL;
    first_at := NULL;

    SELECT count(*)::integer AS starts,
           count(*) FILTER (WHERE v.done)::integer AS confirmed,
           count(*) FILTER (WHERE v.code)::integer AS reached_code,
           count(*) FILTER (WHERE v.code AND NOT v.done AND NOT v.waitlisted)::integer AS left_at_code
      INTO visits
      FROM (
        SELECT f.visit_id,
               bool_or(f.step = 'done') AS done,
               bool_or(f.step = 'waitlisted') AS waitlisted,
               bool_or(f.step = 'verify') AS code
          FROM booking_funnel_events f
         WHERE f.tenant_id = business
         GROUP BY f.visit_id
        HAVING min(f.occurred_at) >= p_since AND min(f.occurred_at) <= p_now
      ) v;
    funnel_starts := funnel_starts + visits.starts;
    funnel_confirmed := funnel_confirmed + visits.confirmed;
    funnel_reached_code := funnel_reached_code + visits.reached_code;
    funnel_left_at_code := funnel_left_at_code + visits.left_at_code;

    SELECT count(*)::integer, count(*) FILTER (WHERE b.status = 'no_show')::integer INTO n, m
      FROM bookings b
     WHERE b.tenant_id = business AND b.source <> 'import' AND b.status <> 'cancelled'
       AND b.starts_at >= p_since AND b.starts_at < p_now;
    past_bookings := past_bookings + n;
    no_shows := no_shows + m;

    -- A slot cancelled ahead of its time (the cancellation is its last change), refilled when
    -- another visit with the same staff member that overlaps it was booked after.
    SELECT count(*)::integer,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM bookings r
              WHERE r.tenant_id = business AND r.staff_member_id = b.staff_member_id AND r.id <> b.id
                AND r.status <> 'cancelled' AND r.source <> 'import'
                AND r.created_at >= b.updated_at
                AND r.starts_at < b.ends_at AND r.ends_at > b.starts_at))::integer
      INTO n, m
      FROM bookings b
     WHERE b.tenant_id = business AND b.status = 'cancelled' AND b.source <> 'import'
       AND b.updated_at >= p_since AND b.updated_at <= p_now AND b.starts_at > b.updated_at;
    cancelled_slots := cancelled_slots + n;
    refilled_slots := refilled_slots + m;

    SELECT count(*)::integer, count(*) FILTER (WHERE o.status = 'claimed')::integer INTO n, m
      FROM waitlist_offers o
     WHERE o.tenant_id = business AND o.created_at >= p_since AND o.created_at <= p_now;
    offers_sent := offers_sent + n;
    offers_claimed := offers_claimed + m;
  END LOOP;
  PERFORM set_config('app.tenant_id', COALESCE(tenant, ''), true);
  PERFORM set_config('app.user_id', COALESCE(member, ''), true);

  -- Each sign-up of the period with its first business's steps (an owner's earliest).
  SELECT count(*)::integer AS signups,
         count(*) FILTER (WHERE s.bookable_at IS NOT NULL)::integer AS reached_bookable,
         count(*) FILTER (WHERE s.first_at IS NOT NULL)::integer AS reached_first_booking,
         percentile_cont(0.5) WITHIN GROUP (
           ORDER BY extract(epoch FROM s.bookable_at - s.occurred_at) / 60)
           FILTER (WHERE s.bookable_at IS NOT NULL) AS minutes_to_bookable,
         percentile_cont(0.5) WITHIN GROUP (
           ORDER BY extract(epoch FROM s.first_at - s.occurred_at) / 60)
           FILTER (WHERE s.first_at IS NOT NULL) AS minutes_to_first_booking
    INTO signup
    FROM (
      SELECT e.occurred_at,
             (SELECT min(x.bookable_at) FROM unnest(owners, bookable_ats) AS x(owner, bookable_at)
               WHERE x.owner = e.account_id) AS bookable_at,
             (SELECT min(x.first_at) FROM unnest(owners, first_ats) AS x(owner, first_at)
               WHERE x.owner = e.account_id) AS first_at
        FROM signup_events e
       WHERE e.occurred_at >= p_since AND e.occurred_at <= p_now
    ) s;

  RETURN jsonb_build_object(
    'businesses', businesses,
    'bookableBusinesses', bookable_businesses,
    'signups', signup.signups,
    'reachedBookable', signup.reached_bookable,
    'reachedFirstBooking', signup.reached_first_booking,
    'minutesToBookable', signup.minutes_to_bookable,
    'minutesToFirstBooking', signup.minutes_to_first_booking,
    'funnelStarts', funnel_starts,
    'funnelConfirmed', funnel_confirmed,
    'funnelReachedCode', funnel_reached_code,
    'funnelLeftAtCode', funnel_left_at_code,
    'pastBookings', past_bookings,
    'noShows', no_shows,
    'cancelledSlots', cancelled_slots,
    'refilledSlots', refilled_slots,
    'offersSent', offers_sent,
    'offersClaimed', offers_claimed
  );
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION operator_pilot_metrics(timestamptz, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION operator_pilot_metrics(timestamptz, timestamptz) TO pepper_app;
