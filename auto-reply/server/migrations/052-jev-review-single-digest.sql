SET search_path=autoreply,public;
-- Forward upgrade: identical complete labels need one recomputed canonical digest.
-- All current identity, latest revision, scope and row-lock checks are retained.
CREATE OR REPLACE FUNCTION autoreply.verify_jev_blind_labels(p_tenant text,p_account text,p_run text,p_packet uuid,p_packet_hash text,p_review uuid,p_labels jsonb)
RETURNS SETOF jev_blind_label_reviews LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,autoreply,pg_temp AS $$
DECLARE actor text;a accounts;e jev_replay_executions;s jev_blind_packet_seals;r evaluation_runs;v jev_blind_label_reviews;reviewer text;
BEGIN
  SELECT actor_id INTO actor FROM autoreply.authenticate_admin(p_tenant);
  IF actor IS NULL THEN RAISE EXCEPTION 'jev_blind_review_admin_denied'; END IF;
  SELECT * INTO a FROM accounts WHERE (tenant_id,id)=(p_tenant,p_account) FOR UPDATE;
  IF NOT FOUND OR NOT a.enabled THEN RAISE EXCEPTION 'jev_blind_review_context_invalid'; END IF;
  PERFORM 1 FROM employees WHERE (tenant_id,id)=(a.tenant_id,a.employee_id) AND enabled FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'jev_blind_review_context_invalid'; END IF;
  SELECT * INTO v FROM jev_blind_label_reviews WHERE (tenant_id,account_id,id)=(p_tenant,p_account,p_review);
  IF NOT FOUND OR v.run_id<>p_run OR v.packet_id<>p_packet OR v.packet_hash IS DISTINCT FROM p_packet_hash THEN RAISE EXCEPTION 'jev_blind_review_changed'; END IF;
  IF v.revision<>(SELECT max(revision) FROM jev_blind_label_reviews WHERE (tenant_id,account_id,packet_id)=(p_tenant,p_account,p_packet)) THEN
    RAISE EXCEPTION 'jev_blind_review_stale'; END IF;
  SELECT * INTO s FROM jev_blind_packet_seals WHERE (tenant_id,account_id,packet_id)=(p_tenant,p_account,p_packet);
  SELECT * INTO e FROM jev_replay_executions WHERE (tenant_id,account_id,id)=(p_tenant,p_account,v.execution_id);
  SELECT * INTO r FROM evaluation_runs WHERE (tenant_id,account_id,id)=(p_tenant,p_account,p_run);
  IF s.packet_id IS NULL OR e.id IS NULL OR r.id IS NULL OR s.packet_hash<>v.packet_hash OR s.execution_id<>v.execution_id
    OR s.run_id<>p_run OR e.run_id<>p_run OR e.actor_id<>actor OR e.login_name<>session_user OR s.actor_id<>e.actor_id OR s.login_name<>e.login_name
    OR (e.employee_id,e.platform) IS DISTINCT FROM (a.employee_id,a.platform)
    OR r.expires_at<=clock_timestamp() OR r.created_at>clock_timestamp() OR r.snapshot_hash<>e.snapshot_hash OR r.publication_json<>e.publication_json OR r.plan_json<>e.plan_json
    OR v.reviewer_id=e.actor_id OR v.reviewer_id=r.created_by THEN RAISE EXCEPTION 'jev_blind_review_context_invalid'; END IF;
  IF NOT autoreply.jev_reviewer_login_allowed(v.reviewer_login) THEN RAISE EXCEPTION 'jev_blind_reviewer_denied'; END IF;
  SELECT p.employee_id INTO reviewer FROM jev_reviewer_database_principals p JOIN employees emp ON (emp.tenant_id,emp.id)=(p.tenant_id,p.employee_id)
    WHERE p.login_name=v.reviewer_login AND (p.tenant_id,p.account_id)=(p_tenant,p_account) AND p.enabled AND emp.enabled FOR SHARE OF p,emp;
  IF reviewer IS DISTINCT FROM v.reviewer_id THEN RAISE EXCEPTION 'jev_blind_reviewer_denied'; END IF;
  -- Compare the complete jsonb representation before hashing: numeric jsonb
  -- equality alone conflates 1 and 1.0, but label canonicalization rejects 1.0.
  -- Rehash the actual stored content once, never trust its hash column.
  IF v.labels_json::text IS DISTINCT FROM p_labels::text OR p_labels->>'adjudicatedBy' IS DISTINCT FROM reviewer THEN
    RAISE EXCEPTION 'jev_blind_review_changed'; END IF;
  IF v.labels_hash IS DISTINCT FROM autoreply.jev_blind_labels_hash(v.labels_json) THEN
    RAISE EXCEPTION 'jev_blind_review_changed'; END IF;
  RETURN NEXT v;
END $$;
REVOKE ALL ON FUNCTION autoreply.verify_jev_blind_labels(text,text,text,uuid,text,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION autoreply.verify_jev_blind_labels(text,text,text,uuid,text,uuid,jsonb) TO autoreply_admin;
