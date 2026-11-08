-- The pilot metrics page, part 2 (S59.4.2, ADR-0062 Part 4, AC-X-50…53): engagement, the AI's
-- cards and the rebook rate from p_since to p_now, for a logged operator only (the same
-- 'metrics.read' transaction as operator_pilot_metrics). Counts and token sums only: no client,
-- booking, member or business row leaves it. Each business is read as itself (its tenant
-- policies, with no member scope), named in every query, as the owner may bypass RLS.
--
-- Definitions (S59.4.2 D-2):
-- * The period is cut into whole weeks ending at p_now (1 of 7 days, 4 of 30), each of 7 days
--   of 24 hours counted back from p_now (so a week is exactly 7 days, never parts of 8 dates).
--   An owner is active on a day with an audit entry they made themselves (not the AI's for
--   them) or a chat turn; an owner-week counts for an owner whose membership began before the
--   week, and is active with 4 or more active days.
-- * Card actions: a proposal approved or declined by a member, an edit of one, a feed card
--   dismissed (not one closed by its proposal; "Dismiss all" closes a group at one moment and
--   is one action), an action undone by a member.
-- * Shown: proposals settled in the period as approved, declined or expired (superseded ones
--   were replaced, not shown to the end). Edited: a member's own revision of a proposal (its
--   replacement's key is the proposal's id + '.edit', ai-actions.ts; a one-tap draft a member
--   asked for is audited as theirs too, so the audit can't tell them apart).
--   Asked again: a declined proposal followed within 10 minutes by a new one for the same
--   action, asked by the member who declined it.
-- * Executed: actions the AI ran in the period; undone as wrong: those a member undid with the
--   reason 'wrong'.
-- * Rebook: a past visit (completed, or confirmed and over) whose client's interval (its
--   service's rebook_after_days, else the client's median gap from 3 or more visits, 7 to 365
--   days, as ADR-0039's rebooking_due) ended in the period, so its outcome is known; rebooked
--   when a later visit (not cancelled) was booked by then (or, imported, took place by then).
CREATE FUNCTION operator_ai_metrics(p_since timestamptz, p_now timestamptz) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  tenant text := current_setting('app.tenant_id', true);
  member text := current_setting('app.user_id', true);
  business uuid;
  ids uuid[];
  weeks integer := floor(extract(epoch FROM p_now - p_since) / 604800)::integer;
  owner_weeks integer := 0;
  active_owner_weeks integer := 0;
  active_businesses integer := 0;
  card_actions integer := 0;
  chat_turns integer := 0;
  shown integer := 0;
  approved integer := 0;
  edited integer := 0;
  asked_again integer := 0;
  executed integer := 0;
  undone_wrong integer := 0;
  input_tokens bigint := 0;
  cached_input_tokens bigint := 0;
  output_tokens bigint := 0;
  rebook_due integer := 0;
  rebooked integer := 0;
  n integer;
  m integer;
  activities integer;
  tokens record;
BEGIN
  IF (SELECT current_operator_id()) IS NULL THEN
    RAISE EXCEPTION 'not a logged operator transaction' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('app.user_id', '', true);
  SELECT COALESCE(array_agg(DISTINCT mm.tenant_id), '{}') INTO ids FROM memberships mm;
  FOREACH business IN ARRAY ids LOOP
    PERFORM set_config('app.tenant_id', business::text, true);
    -- Every member's activity of the period (an audit entry they made, a chat turn). Inline,
    -- never a temp table: a session's temp schema is shared
    -- with the caller, who could have made one of the same name to read it back.
    WITH activity AS (
      SELECT l.actor_user_id AS user_id, l.created_at AS at
        FROM audit_log l
       WHERE l.tenant_id = business AND l.actor_kind = 'user' AND l.actor_user_id IS NOT NULL
         AND l.created_at >= p_since AND l.created_at < p_now
      UNION ALL
      SELECT t.user_id, t.created_at
        FROM conversation_turns t
       WHERE t.tenant_id = business AND t.created_at >= p_since AND t.created_at < p_now
    ), weekly AS (
      SELECT (SELECT count(DISTINCT floor(extract(epoch FROM p_now - a.at) / 86400)) FROM activity a
               WHERE a.user_id = mm.user_id
                 AND a.at >= p_now - (k.week + 1) * interval '7 days'
                 AND a.at < p_now - k.week * interval '7 days') AS days
        FROM memberships mm
        CROSS JOIN generate_series(0, weeks - 1) AS k(week)
       WHERE mm.tenant_id = business AND mm.role = 'owner'
         AND mm.created_at <= p_now - (k.week + 1) * interval '7 days'
    )
    SELECT (SELECT count(*) FROM weekly)::integer,
           (SELECT count(*) FROM weekly w WHERE w.days >= 4)::integer,
           (SELECT count(*) FROM activity)::integer
      INTO n, m, activities;
    IF activities > 0 THEN
      active_businesses := active_businesses + 1;
    END IF;
    owner_weeks := owner_weeks + n;
    active_owner_weeks := active_owner_weeks + m;

    SELECT count(*)::integer INTO n FROM conversation_turns t
     WHERE t.tenant_id = business AND t.created_at >= p_since AND t.created_at < p_now;
    chat_turns := chat_turns + n;

    SELECT count(*) FILTER (WHERE p.status IN ('approved', 'rejected', 'expired'))::integer,
           count(*) FILTER (WHERE p.status = 'approved')::integer
      INTO n, m
      FROM ai_action_proposals p
     WHERE p.tenant_id = business AND p.decided_at >= p_since AND p.decided_at < p_now;
    shown := shown + n;
    approved := approved + m;

    SELECT count(*)::integer INTO n FROM ai_action_proposals p
     WHERE p.tenant_id = business AND p.decided_at >= p_since AND p.decided_at < p_now
       AND p.status IN ('approved', 'rejected') AND p.decided_by_user_id IS NOT NULL;
    card_actions := card_actions + n;

    SELECT count(*)::integer INTO n FROM ai_action_proposals p
     WHERE p.tenant_id = business AND p.status = 'rejected'
       AND p.decided_at >= p_since AND p.decided_at < p_now AND p.decided_by_user_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM ai_action_proposals q
          WHERE q.tenant_id = business AND q.id <> p.id AND q.action = p.action
            AND q.requested_by_user_id = p.decided_by_user_id
            AND q.created_at > p.decided_at
            AND q.created_at <= p.decided_at + interval '10 minutes');
    asked_again := asked_again + n;

    SELECT count(*)::integer INTO n FROM ai_action_proposals p
     WHERE p.tenant_id = business AND p.idempotency_key LIKE '%.edit'
       AND p.created_at >= p_since AND p.created_at < p_now;
    edited := edited + n;
    card_actions := card_actions + n;

    SELECT count(DISTINCT f.acted_at)::integer INTO n FROM feed_items f
     WHERE f.tenant_id = business AND f.status = 'dismissed' AND f.action_proposal_id IS NULL
       AND f.acted_at >= p_since AND f.acted_at < p_now;
    card_actions := card_actions + n;

    SELECT count(*)::integer INTO n FROM ai_action_executions e
     WHERE e.tenant_id = business AND e.undone_by_user_id IS NOT NULL
       AND e.undone_at >= p_since AND e.undone_at < p_now;
    card_actions := card_actions + n;

    SELECT count(*)::integer,
           count(*) FILTER (WHERE e.status = 'undone' AND e.undo_reason = 'wrong'
                              AND e.undone_at < p_now)::integer
      INTO n, m
      FROM ai_action_executions e
     WHERE e.tenant_id = business AND e.created_at >= p_since AND e.created_at < p_now;
    executed := executed + n;
    undone_wrong := undone_wrong + m;

    SELECT COALESCE(sum(t.input_tokens), 0)::bigint AS input,
           COALESCE(sum(t.cached_input_tokens), 0)::bigint AS cached,
           COALESCE(sum(t.output_tokens), 0)::bigint AS output
      INTO tokens
      FROM conversation_turns t
     WHERE t.tenant_id = business AND t.created_at >= p_since AND t.created_at < p_now;
    input_tokens := input_tokens + tokens.input;
    cached_input_tokens := cached_input_tokens + tokens.cached;
    output_tokens := output_tokens + tokens.output;

    WITH visits AS (
      SELECT b.id, b.client_id, b.service_id, b.starts_at
        FROM bookings b
       WHERE b.tenant_id = business AND b.starts_at < p_now
         AND (b.status = 'completed' OR (b.status = 'confirmed' AND b.ends_at <= p_now))
    ), gaps AS (
      SELECT v.client_id,
             extract(epoch FROM v.starts_at - lag(v.starts_at) OVER (
               PARTITION BY v.client_id ORDER BY v.starts_at)) / 86400 AS days
        FROM visits v
    ), medians AS (
      SELECT g.client_id,
             LEAST(365, GREATEST(7, round(percentile_cont(0.5) WITHIN GROUP (ORDER BY g.days))))
               AS days
        FROM gaps g
       WHERE g.days IS NOT NULL
       GROUP BY g.client_id
      HAVING count(*) >= 2
    ), due AS (
      SELECT v.id, v.client_id, v.starts_at,
             v.starts_at + COALESCE(s.rebook_after_days, md.days) * interval '1 day' AS due_at
        FROM visits v
        LEFT JOIN services s ON s.tenant_id = business AND s.id = v.service_id
        LEFT JOIN medians md ON md.client_id = v.client_id
       WHERE COALESCE(s.rebook_after_days, md.days) IS NOT NULL
    )
    SELECT count(*)::integer,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM bookings r
              WHERE r.tenant_id = business AND r.client_id = d.client_id AND r.id <> d.id
                AND r.status <> 'cancelled' AND r.starts_at > d.starts_at
                AND (r.starts_at <= d.due_at
                     OR (r.source <> 'import' AND r.created_at <= d.due_at))))::integer
      INTO n, m
      FROM due d
     WHERE d.due_at >= p_since AND d.due_at < p_now;
    rebook_due := rebook_due + n;
    rebooked := rebooked + m;
  END LOOP;
  PERFORM set_config('app.tenant_id', COALESCE(tenant, ''), true);
  PERFORM set_config('app.user_id', COALESCE(member, ''), true);

  RETURN jsonb_build_object(
    'ownerWeeks', owner_weeks,
    'activeOwnerWeeks', active_owner_weeks,
    'activeBusinesses', active_businesses,
    'cardActions', card_actions,
    'chatTurns', chat_turns,
    'proposalsShown', shown,
    'proposalsApproved', approved,
    'proposalsEdited', edited,
    'proposalsAskedAgain', asked_again,
    'actionsExecuted', executed,
    'actionsUndoneWrong', undone_wrong,
    'inputTokens', input_tokens,
    'cachedInputTokens', cached_input_tokens,
    'outputTokens', output_tokens,
    'rebookDue', rebook_due,
    'rebooked', rebooked
  );
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION operator_ai_metrics(timestamptz, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION operator_ai_metrics(timestamptz, timestamptz) TO pepper_app;
