SET search_path=autoreply,public;
-- Upgrade existing databases to the same guard as the fresh 045 definition.
-- Keep original account lock, order, ownership and all attempt quotas.
CREATE OR REPLACE FUNCTION autoreply.jev_replay_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,autoreply AS $$
DECLARE a accounts; e jev_replay_executions; b jev_replay_assignments; l jev_replay_limits;
  actor text; head uuid; day date; n integer; prior jev_replay_attempts;
BEGIN
  SELECT actor_id INTO actor FROM autoreply.authenticate_admin(NEW.tenant_id);
  IF actor IS NULL THEN RAISE EXCEPTION 'jev_replay_denied'; END IF;
  SELECT * INTO a FROM accounts WHERE (tenant_id,id)=(NEW.tenant_id,NEW.account_id) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'jev_replay_account_invalid'; END IF;
  IF TG_TABLE_NAME='jev_replay_results' THEN
    SELECT * INTO prior FROM jev_replay_attempts WHERE (tenant_id,account_id,id)=(NEW.tenant_id,NEW.account_id,NEW.attempt_id);
    SELECT * INTO b FROM jev_replay_assignments WHERE (tenant_id,account_id,id)=(prior.tenant_id,prior.account_id,prior.assignment_id);
    SELECT * INTO e FROM jev_replay_executions WHERE (tenant_id,account_id,id)=(b.tenant_id,b.account_id,b.execution_id);
    IF prior.id IS NULL OR b.id IS NULL OR e.id IS NULL OR e.actor_id<>actor OR e.login_name<>session_user THEN RAISE EXCEPTION 'jev_replay_denied'; END IF;
    NEW.recorded_at:=clock_timestamp(); RETURN NEW;
  END IF;
  IF NOT a.enabled OR NOT EXISTS(SELECT 1 FROM employees WHERE (tenant_id,id)=(a.tenant_id,a.employee_id) AND enabled) THEN
    RAISE EXCEPTION 'jev_replay_account_invalid'; END IF;
  IF TG_TABLE_NAME='jev_replay_limits' THEN
    NEW.revision:=CASE WHEN TG_OP='UPDATE' THEN OLD.revision+CASE WHEN OLD.daily_attempt_limit=NEW.daily_attempt_limit THEN 0 ELSE 1 END ELSE 1 END;
    RETURN NEW;
  END IF;
  SELECT request_id INTO head FROM account_pause_heads WHERE (tenant_id,account_id)=(a.tenant_id,a.id);
  IF TG_TABLE_NAME='jev_replay_executions' THEN
    e:=NEW;
    NEW.actor_id:=actor;NEW.login_name:=session_user;NEW.initial_paused:=a.paused;NEW.pause_head:=head;NEW.created_at:=clock_timestamp();
  ELSIF TG_TABLE_NAME='jev_replay_assignments' THEN
    SELECT * INTO e FROM jev_replay_executions WHERE (tenant_id,account_id,id)=(NEW.tenant_id,NEW.account_id,NEW.execution_id);
  ELSE
    SELECT * INTO b FROM jev_replay_assignments WHERE (tenant_id,account_id,id)=(NEW.tenant_id,NEW.account_id,NEW.assignment_id);
    SELECT * INTO e FROM jev_replay_executions WHERE (tenant_id,account_id,id)=(b.tenant_id,b.account_id,b.execution_id);
  END IF;
  IF e.id IS NULL OR (e.employee_id,e.platform) IS DISTINCT FROM (a.employee_id,a.platform)
    OR (TG_TABLE_NAME<>'jev_replay_executions' AND (e.actor_id<>actor OR e.login_name<>session_user OR e.initial_paused<>a.paused OR e.pause_head IS DISTINCT FROM head))
    OR NOT EXISTS(SELECT 1 FROM evaluation_runs r WHERE (r.tenant_id,r.account_id,r.id)=(e.tenant_id,e.account_id,e.run_id)
      AND r.created_at<=clock_timestamp() AND r.expires_at>clock_timestamp() AND r.snapshot_hash=e.snapshot_hash
      AND r.publication_json=e.publication_json AND r.plan_json=e.plan_json AND r.plan_json->>'replayProtocol'='jev-abc-v1') THEN
    RAISE EXCEPTION 'jev_replay_context_invalid'; END IF;
  IF TG_TABLE_NAME='jev_replay_executions' THEN
    IF e.input_json->>'datasetId' IS DISTINCT FROM e.plan_json->>'datasetId' OR e.input_json->>'split' IS DISTINCT FROM e.split
      OR jsonb_typeof(e.input_json->'cases') IS DISTINCT FROM 'array'
      OR (SELECT count(*) FROM jsonb_array_elements(e.input_json->'cases'))<>(SELECT count(*) FROM jsonb_array_elements(e.plan_json->'assignments') p WHERE p->>'split'=e.split)
      OR (SELECT count(DISTINCT c->>'caseId') FROM jsonb_array_elements(e.input_json->'cases') c)<>(SELECT count(*) FROM jsonb_array_elements(e.input_json->'cases'))
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(e.input_json->'cases') c WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(e.plan_json->'assignments') p
        WHERE p->>'caseId'=c->>'caseId' AND p->>'conversationGroup'=c->>'conversationGroup' AND p->>'split'=e.split AND c->>'split'=e.split)) THEN
      RAISE EXCEPTION 'jev_replay_split_invalid'; END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME='jev_replay_assignments' THEN
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(e.plan_json->'assignments') p WHERE p->>'caseId'=NEW.case_id AND p->>'split'=e.split AND p->>'inputHash'=NEW.input_hash) THEN
      RAISE EXCEPTION 'jev_replay_assignment_invalid'; END IF;
    RETURN NEW;
  END IF;
  IF jsonb_typeof(NEW.start_json) IS DISTINCT FROM 'object' OR NEW.start_json->>'requestHash' IS NULL
    OR NOT (NEW.start_json->>'requestHash' ~ '^[a-f0-9]{64}$') OR coalesce(length(NEW.start_json->>'requestedModel'),0)=0
    OR NEW.start_json->>'provider' IS DISTINCT FROM (CASE WHEN NEW.stage='text' THEN 'text' ELSE 'jev' END)
    OR (b.arm='A' AND NEW.stage<>'text') OR (b.arm='B' AND NEW.stage='post')
    OR (NEW.stage<>'text' AND (NEW.start_json->>'requestedModel' IS DISTINCT FROM e.publication_json->'policy'->>'modelAlias'
      OR NEW.start_json->>'questionHash' IS DISTINCT FROM (CASE WHEN NEW.stage='pre' THEN e.pre_question_hash ELSE e.post_question_hash END))) THEN
    RAISE EXCEPTION 'jev_replay_stage_invalid'; END IF;
  IF (NEW.stage='text' AND b.arm<>'A' AND NOT EXISTS(SELECT 1 FROM jev_replay_attempts t
      WHERE (t.tenant_id,t.account_id,t.assignment_id)=(b.tenant_id,b.account_id,b.id) AND t.stage='pre'
        AND EXISTS(SELECT 1 FROM jev_replay_results r WHERE (r.tenant_id,r.account_id,r.attempt_id)=(t.tenant_id,t.account_id,t.id) AND r.result_json->>'outcome'='response')))
    OR (NEW.stage='post' AND NOT EXISTS(SELECT 1 FROM jev_replay_attempts t
      WHERE (t.tenant_id,t.account_id,t.assignment_id)=(b.tenant_id,b.account_id,b.id) AND t.stage='text'
        AND EXISTS(SELECT 1 FROM jev_replay_results r WHERE (r.tenant_id,r.account_id,r.attempt_id)=(t.tenant_id,t.account_id,t.id) AND r.result_json->>'outcome'='response')))
    OR EXISTS(SELECT 1 FROM jev_replay_attempts t
      WHERE (t.tenant_id,t.account_id,t.assignment_id)=(b.tenant_id,b.account_id,b.id)
        AND NOT EXISTS(SELECT 1 FROM jev_replay_results r WHERE (r.tenant_id,r.account_id,r.attempt_id)=(t.tenant_id,t.account_id,t.id))) THEN
    RAISE EXCEPTION 'jev_replay_unfinished_or_out_of_order'; END IF;
  SELECT * INTO prior FROM jev_replay_attempts WHERE (tenant_id,account_id,assignment_id,stage)=(b.tenant_id,b.account_id,b.id,NEW.stage) ORDER BY attempt_number DESC LIMIT 1;
  IF coalesce(prior.attempt_number,0)>=(CASE WHEN NEW.stage='text' THEN 1 ELSE 2 END) THEN
    RAISE EXCEPTION 'jev_replay_stage_attempt_limit'; END IF;
  IF FOUND AND (prior.start_json<>NEW.start_json OR EXISTS(SELECT 1 FROM jev_replay_results WHERE (tenant_id,account_id,attempt_id)=(prior.tenant_id,prior.account_id,prior.id) AND result_json->>'outcome' IN ('response','not_dispatched','cancelled'))
    OR EXISTS(SELECT 1 FROM jev_replay_attempts WHERE (tenant_id,account_id,assignment_id)=(b.tenant_id,b.account_id,b.id) AND stage<>NEW.stage AND stage=(CASE WHEN NEW.stage='pre' THEN 'text' ELSE 'post' END))) THEN
    RAISE EXCEPTION 'jev_replay_stage_already_closed'; END IF;
  SELECT * INTO l FROM jev_replay_limits WHERE (tenant_id,account_id)=(a.tenant_id,a.id);
  IF NOT FOUND THEN RAISE EXCEPTION 'jev_replay_limit_unconfigured'; END IF;
  day:=(clock_timestamp() AT TIME ZONE 'UTC')::date;
  SELECT count(*) INTO n FROM jev_replay_attempts WHERE (tenant_id,account_id,usage_day)=(a.tenant_id,a.id,day);
  IF n>=l.daily_attempt_limit OR (SELECT count(*) FROM jev_replay_attempts t
    WHERE (t.tenant_id,t.account_id)=(e.tenant_id,e.account_id) AND t.assignment_id=ANY(ARRAY(
      SELECT s.id FROM jev_replay_assignments s WHERE (s.tenant_id,s.account_id,s.execution_id)=(e.tenant_id,e.account_id,e.id))))>=e.max_attempts THEN RAISE EXCEPTION 'jev_replay_limit_reached'; END IF;
  NEW.attempt_number:=coalesce(prior.attempt_number,0)+1;NEW.usage_day:=day;NEW.limit_revision:=l.revision;NEW.reserved_at:=clock_timestamp();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION autoreply.jev_replay_guard() FROM PUBLIC;
-- The restrictive policy still requires the row tenant AND authenticated
-- session login for that tenant. Its uncorrelated subquery runs once per
-- statement, retaining authenticate_admin's row locks without rechecking
-- every historical ledger row. A caller-controlled GUC grants no authority.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['jev_replay_limits','jev_replay_executions','jev_replay_assignments',
    'jev_replay_attempts','jev_replay_results','jev_replay_artifact_seals'] LOOP
    EXECUTE format('ALTER POLICY admin_login_scope ON %I USING(
      tenant_id=current_setting(''app.tenant_id'',true) AND
      EXISTS(SELECT 1 FROM autoreply.authenticate_admin(current_setting(''app.tenant_id'',true))))
      WITH CHECK(tenant_id=current_setting(''app.tenant_id'',true) AND
      EXISTS(SELECT 1 FROM autoreply.authenticate_admin(current_setting(''app.tenant_id'',true))))',t);
  END LOOP;
END $$;
