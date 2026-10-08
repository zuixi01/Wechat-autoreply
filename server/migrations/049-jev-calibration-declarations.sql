SET search_path=autoreply,public;
-- One immutable candidate grid per frozen run, committed before ANY execution.
-- The database hashes the submitted canonical JSON bytes, never a caller digest.
CREATE TABLE IF NOT EXISTS jev_calibration_declarations (
  tenant_id text NOT NULL,account_id text NOT NULL,run_id text NOT NULL,id uuid NOT NULL,
  snapshot_hash text NOT NULL,publication_json jsonb NOT NULL,plan_json jsonb NOT NULL,
  settings_canonical text NOT NULL CHECK(octet_length(settings_canonical)<=1048576),
  settings_json jsonb NOT NULL,settings_hash text NOT NULL CHECK(settings_hash ~ '^[a-f0-9]{64}$'),
  employee_id text NOT NULL,platform text NOT NULL CHECK(platform IN ('wechat','wework')),
  actor_id text NOT NULL,login_name name NOT NULL,declared_at timestamptz NOT NULL,
  PRIMARY KEY(tenant_id,account_id,run_id),UNIQUE(tenant_id,account_id,id),
  FOREIGN KEY(tenant_id,account_id,run_id) REFERENCES evaluation_runs(tenant_id,account_id,id)
);
CREATE OR REPLACE FUNCTION autoreply.jev_calibration_declaration(
  p_tenant text,p_account text,p_run text,p_canonical text,p_create boolean)
RETURNS SETOF jev_calibration_declarations LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,autoreply,pg_temp AS $$
DECLARE actor text;a accounts;r evaluation_runs;d jev_calibration_declarations;s jsonb;c jsonb;t jsonb;k text;
  tunable text[]:=ARRAY['minimumChoiceProbability','minimumChoiceConfidence','minimumChoiceMargin','presentIntentProbability','humanRequestThreshold','minimumAuditProbability'];
BEGIN
  IF NOT pg_has_role(session_user,'autoreply_admin','USAGE')
    OR pg_has_role(session_user,'autoreply_app','MEMBER')
    OR pg_has_role(session_user,'autoreply_learning_worker','MEMBER')
    OR pg_has_role(session_user,'autoreply_jev_reviewer','MEMBER')
    OR EXISTS(SELECT 1 FROM pg_roles WHERE (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)
      AND pg_has_role(session_user,oid,'MEMBER')) THEN RAISE EXCEPTION 'jev_calibration_declaration_denied'; END IF;
  SELECT actor_id INTO actor FROM autoreply.authenticate_admin(p_tenant);
  IF actor IS NULL THEN RAISE EXCEPTION 'jev_calibration_declaration_denied'; END IF;
  SELECT * INTO a FROM accounts WHERE (tenant_id,id)=(p_tenant,p_account) FOR UPDATE;
  IF NOT FOUND OR NOT a.enabled THEN RAISE EXCEPTION 'jev_calibration_declaration_context_invalid'; END IF;
  PERFORM 1 FROM employees WHERE (tenant_id,id)=(a.tenant_id,a.employee_id) AND enabled FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'jev_calibration_declaration_context_invalid'; END IF;
  SELECT * INTO r FROM evaluation_runs WHERE (tenant_id,account_id,id)=(p_tenant,p_account,p_run);
  IF NOT FOUND OR r.created_by<>actor OR r.expires_at<=clock_timestamp() OR r.created_at>clock_timestamp()
    OR r.plan_json->>'replayProtocol' IS DISTINCT FROM 'jev-abc-v1'
    OR r.publication_json->'policy'->>'mode' IS DISTINCT FROM 'enforced'
    OR r.publication_json->'policy'->'evaluationApproved' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'jev_calibration_declaration_context_invalid'; END IF;
  IF (r.publication_json->'policy'->>'presentIntentProbability')::numeric<=0.5 THEN
    RAISE EXCEPTION 'jev_calibration_settings_invalid'; END IF;
  IF p_canonical IS NULL OR octet_length(p_canonical)>1048576 THEN RAISE EXCEPTION 'jev_calibration_settings_invalid'; END IF;
  s:=p_canonical::jsonb;t:=s->'targets';
  IF jsonb_typeof(s) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(s))<>2
    OR jsonb_typeof(s->'candidates') IS DISTINCT FROM 'array'
    OR jsonb_typeof(t) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'jev_calibration_settings_invalid'; END IF;
  IF jsonb_array_length(s->'candidates') NOT BETWEEN 1 AND 500
    OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(s->'candidates'))<>jsonb_array_length(s->'candidates')
    OR (SELECT count(*) FROM jsonb_object_keys(t))<>3
    OR jsonb_typeof(t->'maximumErrorReleaseRate') IS DISTINCT FROM 'number'
    OR jsonb_typeof(t->'minimumAutomaticCoverage') IS DISTINCT FROM 'number'
    OR jsonb_typeof(t->'minimumAutomaticReplies') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'jev_calibration_settings_invalid'; END IF;
  IF (t->>'maximumErrorReleaseRate')::numeric NOT BETWEEN 0 AND 1
    OR (t->>'minimumAutomaticCoverage')::numeric<=0 OR (t->>'minimumAutomaticCoverage')::numeric>1
    OR (t->>'minimumAutomaticReplies')::numeric NOT BETWEEN 30 AND 2000
    OR trunc((t->>'minimumAutomaticReplies')::numeric)<>(t->>'minimumAutomaticReplies')::numeric THEN
    RAISE EXCEPTION 'jev_calibration_settings_invalid'; END IF;
  FOR c IN SELECT value FROM jsonb_array_elements(s->'candidates') LOOP
    IF jsonb_typeof(c) IS DISTINCT FROM 'object' OR (c-tunable) IS DISTINCT FROM ((r.publication_json->'policy')-tunable) THEN
      RAISE EXCEPTION 'jev_calibration_settings_invalid'; END IF;
    FOREACH k IN ARRAY tunable LOOP
      IF jsonb_typeof(c->k) IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'jev_calibration_settings_invalid'; END IF;
      IF (c->>k)::numeric NOT BETWEEN 0 AND 1 THEN RAISE EXCEPTION 'jev_calibration_settings_invalid'; END IF;
    END LOOP;
    IF (c->>'presentIntentProbability')::numeric<=0.5 THEN RAISE EXCEPTION 'jev_calibration_settings_invalid'; END IF;
  END LOOP;
  SELECT * INTO d FROM jev_calibration_declarations WHERE (tenant_id,account_id,run_id)=(p_tenant,p_account,p_run);
  IF FOUND THEN
    IF d.actor_id<>actor OR d.login_name<>session_user OR d.settings_canonical<>p_canonical OR d.settings_json<>s
      OR d.settings_hash<>encode(sha256(convert_to(p_canonical,'UTF8')),'hex')
      OR d.snapshot_hash<>r.snapshot_hash OR d.publication_json<>r.publication_json OR d.plan_json<>r.plan_json
      OR (d.employee_id,d.platform) IS DISTINCT FROM (a.employee_id,a.platform)
      OR d.declared_at<r.created_at OR d.declared_at>clock_timestamp()
      OR EXISTS(SELECT 1 FROM jev_replay_executions x WHERE (x.tenant_id,x.account_id,x.run_id)=(p_tenant,p_account,p_run)
        AND (x.created_at<=d.declared_at OR x.actor_id<>d.actor_id OR x.login_name<>d.login_name)) THEN
      RAISE EXCEPTION 'jev_calibration_declaration_changed'; END IF;
    RETURN NEXT d;RETURN;
  END IF;
  IF NOT p_create THEN RAISE EXCEPTION 'jev_calibration_declaration_missing'; END IF;
  IF EXISTS(SELECT 1 FROM jev_replay_executions WHERE (tenant_id,account_id,run_id)=(p_tenant,p_account,p_run)) THEN
    RAISE EXCEPTION 'jev_calibration_declaration_too_late'; END IF;
  RETURN QUERY INSERT INTO jev_calibration_declarations(
    tenant_id,account_id,run_id,id,snapshot_hash,publication_json,plan_json,settings_canonical,settings_json,settings_hash,employee_id,platform,actor_id,login_name,declared_at)
    VALUES(p_tenant,p_account,p_run,gen_random_uuid(),r.snapshot_hash,r.publication_json,r.plan_json,p_canonical,s,
      encode(sha256(convert_to(p_canonical,'UTF8')),'hex'),a.employee_id,a.platform,actor,session_user,clock_timestamp()) RETURNING *;
END $$;
REVOKE ALL ON FUNCTION autoreply.jev_calibration_declaration(text,text,text,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION autoreply.jev_calibration_declaration(text,text,text,text,boolean) TO autoreply_admin;
ALTER TABLE jev_calibration_declarations ENABLE ROW LEVEL SECURITY;
ALTER TABLE jev_calibration_declarations FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename='jev_calibration_declarations' AND policyname='tenant_scope') THEN
    CREATE POLICY tenant_scope ON jev_calibration_declarations USING(tenant_id=current_setting('app.tenant_id',true)) WITH CHECK(false);
    CREATE POLICY admin_login_scope ON jev_calibration_declarations AS RESTRICTIVE TO autoreply_admin
      USING(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id))) WITH CHECK(false);
  END IF;
END $$;
DROP TRIGGER IF EXISTS jev_calibration_declarations_immutable ON jev_calibration_declarations;
CREATE TRIGGER jev_calibration_declarations_immutable BEFORE UPDATE OR DELETE ON jev_calibration_declarations
  FOR EACH ROW EXECUTE FUNCTION autoreply.jev_replay_immutable();
REVOKE ALL ON jev_calibration_declarations FROM PUBLIC,autoreply_app,autoreply_learning_worker,autoreply_admin,autoreply_jev_reviewer;
GRANT SELECT ON jev_calibration_declarations TO autoreply_admin;
