SET search_path=autoreply,public;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='autoreply_jev_reviewer') THEN
    CREATE ROLE autoreply_jev_reviewer NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='autoreply_jev_reviewer' AND (rolcanlogin OR rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'jev_reviewer_group_invalid'; END IF;
END $$;
-- Only the migration operator provisions these bindings. Reviewers receive no
-- administrator rights and cannot read private execution/packet mappings.
CREATE TABLE IF NOT EXISTS jev_reviewer_database_principals (
  login_name name NOT NULL,tenant_id text NOT NULL,account_id text NOT NULL,employee_id text NOT NULL,enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY(login_name,tenant_id,account_id),
  FOREIGN KEY(tenant_id,account_id) REFERENCES accounts(tenant_id,id),
  FOREIGN KEY(tenant_id,employee_id) REFERENCES employees(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS jev_blind_label_reviews (
  tenant_id text NOT NULL,account_id text NOT NULL,id uuid NOT NULL,packet_id uuid NOT NULL,run_id text NOT NULL,execution_id uuid NOT NULL,
  packet_hash text NOT NULL CHECK(packet_hash ~ '^[a-f0-9]{64}$'),labels_hash text NOT NULL CHECK(labels_hash ~ '^[a-f0-9]{64}$'),
  labels_json jsonb NOT NULL CHECK(jsonb_typeof(labels_json)='object' AND octet_length(labels_json::text)<=2000000),
  reviewer_id text NOT NULL,reviewer_login name NOT NULL,revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,account_id,id),
  UNIQUE(tenant_id,account_id,packet_id,revision),
  FOREIGN KEY(tenant_id,account_id,packet_id) REFERENCES jev_blind_packet_seals(tenant_id,account_id,packet_id),
  FOREIGN KEY(tenant_id,account_id,execution_id) REFERENCES jev_replay_executions(tenant_id,account_id,id),
  FOREIGN KEY(tenant_id,account_id,run_id) REFERENCES evaluation_runs(tenant_id,account_id,id),
  FOREIGN KEY(tenant_id,reviewer_id) REFERENCES employees(tenant_id,id)
);
CREATE OR REPLACE FUNCTION autoreply.jev_reviewer_login_allowed(p_login name) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,autoreply AS $$
  SELECT pg_has_role(p_login,'autoreply_jev_reviewer','USAGE')
    AND NOT pg_has_role(p_login,'autoreply_admin','MEMBER')
    AND NOT pg_has_role(p_login,'autoreply_app','MEMBER')
    AND NOT pg_has_role(p_login,'autoreply_learning_worker','MEMBER')
    AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE (rolsuper OR rolbypassrls) AND pg_has_role(p_login,oid,'MEMBER'))
$$;
-- Canonical known keys match hashContext exactly; no caller-supplied hash is
-- accepted. JSON string escaping is delegated to PostgreSQL's JSON encoder.
CREATE OR REPLACE FUNCTION autoreply.jev_blind_labels_hash(p_labels jsonb) RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,autoreply AS $$
DECLARE l jsonb;canonical text;items text;BEGIN
  IF jsonb_typeof(p_labels) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p_labels))<>3
    OR jsonb_typeof(p_labels->'adjudicatedBy') IS DISTINCT FROM 'string'
    OR char_length(p_labels->>'adjudicatedBy') NOT BETWEEN 1 AND 128
    OR p_labels->>'adjudicatedBy'<>btrim(p_labels->>'adjudicatedBy')
    OR p_labels->>'annotationSource' IS DISTINCT FROM 'blinded_business_adjudication'
    OR jsonb_typeof(p_labels->'labels') IS DISTINCT FROM 'array'
    OR octet_length(p_labels::text)>2000000 THEN RAISE EXCEPTION 'jev_blind_labels_invalid'; END IF;
  IF jsonb_array_length(p_labels->'labels') NOT BETWEEN 3 AND 6000 THEN RAISE EXCEPTION 'jev_blind_labels_invalid'; END IF;
  FOR l IN SELECT value FROM jsonb_array_elements(p_labels->'labels') LOOP
    IF jsonb_typeof(l) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(l))<>6
      OR jsonb_typeof(l->'reviewId') IS DISTINCT FROM 'string'
      OR NOT coalesce(l->>'reviewId' ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$',false)
      OR jsonb_typeof(l->'substantialCorrection') NOT IN ('boolean','null') OR NOT l ? 'substantialCorrection'
      OR jsonb_typeof(l->'severeFactError') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(l->'unauthorizedPromise') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(l->'incorrectlyBlocked') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(l->'coveredIntents') IS DISTINCT FROM 'number'
      OR NOT coalesce(l->>'coveredIntents' ~ '^(0|[1-9][0-9]*)$',false) THEN RAISE EXCEPTION 'jev_blind_labels_invalid'; END IF;
    IF (l->>'coveredIntents')::numeric>9007199254740991 THEN RAISE EXCEPTION 'jev_blind_labels_invalid'; END IF;
  END LOOP;
  IF (SELECT count(DISTINCT (value->>'reviewId')::uuid) FROM jsonb_array_elements(p_labels->'labels'))<>jsonb_array_length(p_labels->'labels') THEN
    RAISE EXCEPTION 'jev_blind_labels_duplicate'; END IF;
  SELECT string_agg('{"coveredIntents":'||(value->'coveredIntents')::text||',"incorrectlyBlocked":'||(value->'incorrectlyBlocked')::text||
    ',"reviewId":'||(value->'reviewId')::text||',"severeFactError":'||(value->'severeFactError')::text||
    ',"substantialCorrection":'||(value->'substantialCorrection')::text||',"unauthorizedPromise":'||(value->'unauthorizedPromise')::text||'}',',' ORDER BY ordinal)
    INTO items FROM jsonb_array_elements(p_labels->'labels') WITH ORDINALITY AS x(value,ordinal);
  canonical:='{"adjudicatedBy":'||(p_labels->'adjudicatedBy')::text||',"annotationSource":"blinded_business_adjudication","labels":['||items||']}';
  RETURN encode(sha256(convert_to(canonical,'UTF8')),'hex');
END $$;
CREATE OR REPLACE FUNCTION autoreply.submit_jev_blind_labels(p_tenant text,p_account text,p_run text,p_packet uuid,p_labels jsonb)
RETURNS SETOF jev_blind_label_reviews LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,autoreply,pg_temp AS $$
DECLARE actor text;a accounts;e jev_replay_executions;s jev_blind_packet_seals;r evaluation_runs;last jev_blind_label_reviews;digest text;
BEGIN
  IF NOT autoreply.jev_reviewer_login_allowed(session_user) THEN RAISE EXCEPTION 'jev_blind_reviewer_denied'; END IF;
  SELECT * INTO a FROM accounts WHERE (tenant_id,id)=(p_tenant,p_account) FOR UPDATE;
  IF NOT FOUND OR NOT a.enabled THEN RAISE EXCEPTION 'jev_blind_reviewer_denied'; END IF;
  SELECT p.employee_id INTO actor FROM jev_reviewer_database_principals p JOIN employees emp ON (emp.tenant_id,emp.id)=(p.tenant_id,p.employee_id)
    WHERE p.login_name=session_user AND (p.tenant_id,p.account_id)=(p_tenant,p_account) AND p.enabled AND emp.enabled FOR SHARE OF p,emp;
  IF actor IS NULL THEN RAISE EXCEPTION 'jev_blind_reviewer_denied'; END IF;
  PERFORM 1 FROM employees WHERE (tenant_id,id)=(a.tenant_id,a.employee_id) AND enabled FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'jev_blind_reviewer_denied'; END IF;
  SELECT * INTO s FROM jev_blind_packet_seals WHERE (tenant_id,account_id,packet_id)=(p_tenant,p_account,p_packet);
  IF NOT FOUND OR s.run_id<>p_run THEN RAISE EXCEPTION 'jev_blind_review_packet_invalid'; END IF;
  SELECT * INTO e FROM jev_replay_executions WHERE (tenant_id,account_id,id)=(s.tenant_id,s.account_id,s.execution_id);
  SELECT * INTO r FROM evaluation_runs WHERE (tenant_id,account_id,id)=(p_tenant,p_account,p_run);
  IF r.id IS NULL OR e.id IS NULL OR actor=e.actor_id OR actor=r.created_by
    OR (e.employee_id,e.platform) IS DISTINCT FROM (a.employee_id,a.platform)
    OR s.actor_id<>e.actor_id OR s.login_name<>e.login_name OR e.run_id<>r.id
    OR r.expires_at<=clock_timestamp() OR r.created_at>clock_timestamp() OR r.snapshot_hash<>e.snapshot_hash
    OR r.publication_json<>e.publication_json OR r.plan_json<>e.plan_json THEN RAISE EXCEPTION 'jev_blind_review_independence_or_context_invalid'; END IF;
  digest:=autoreply.jev_blind_labels_hash(p_labels);
  IF p_labels->>'adjudicatedBy' IS DISTINCT FROM actor OR jsonb_array_length(p_labels->'labels')<>jsonb_array_length(e.input_json->'cases')*3 THEN
    RAISE EXCEPTION 'jev_blind_labels_identity_or_count_invalid'; END IF;
  SELECT * INTO last FROM jev_blind_label_reviews WHERE (tenant_id,account_id,packet_id)=(p_tenant,p_account,p_packet) ORDER BY revision DESC LIMIT 1;
  IF FOUND AND last.labels_hash=digest AND last.labels_json=p_labels AND last.reviewer_id=actor AND last.reviewer_login=session_user THEN
    RETURN NEXT last;RETURN; END IF;
  RETURN QUERY INSERT INTO jev_blind_label_reviews(tenant_id,account_id,id,packet_id,run_id,execution_id,packet_hash,labels_hash,labels_json,reviewer_id,reviewer_login,revision)
    VALUES(p_tenant,p_account,gen_random_uuid(),p_packet,p_run,e.id,s.packet_hash,digest,p_labels,actor,session_user,coalesce(last.revision,0)+1) RETURNING *;
END $$;
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
REVOKE ALL ON FUNCTION autoreply.jev_reviewer_login_allowed(name),autoreply.jev_blind_labels_hash(jsonb),autoreply.submit_jev_blind_labels(text,text,text,uuid,jsonb),autoreply.verify_jev_blind_labels(text,text,text,uuid,text,uuid,jsonb) FROM PUBLIC;
GRANT USAGE ON SCHEMA autoreply TO autoreply_jev_reviewer;
GRANT EXECUTE ON FUNCTION autoreply.submit_jev_blind_labels(text,text,text,uuid,jsonb) TO autoreply_jev_reviewer;
GRANT EXECUTE ON FUNCTION autoreply.verify_jev_blind_labels(text,text,text,uuid,text,uuid,jsonb) TO autoreply_admin;
ALTER TABLE jev_reviewer_database_principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE jev_reviewer_database_principals FORCE ROW LEVEL SECURITY;
ALTER TABLE jev_blind_label_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE jev_blind_label_reviews FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename='jev_blind_label_reviews' AND policyname='tenant_scope') THEN
    CREATE POLICY tenant_scope ON jev_blind_label_reviews USING(tenant_id=current_setting('app.tenant_id',true)) WITH CHECK(false);
    CREATE POLICY admin_login_scope ON jev_blind_label_reviews AS RESTRICTIVE TO autoreply_admin USING(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id))) WITH CHECK(false);
  END IF;
END $$;
DROP TRIGGER IF EXISTS jev_blind_reviews_immutable ON jev_blind_label_reviews;
CREATE TRIGGER jev_blind_reviews_immutable BEFORE UPDATE OR DELETE ON jev_blind_label_reviews FOR EACH ROW EXECUTE FUNCTION autoreply.jev_replay_immutable();
REVOKE ALL ON jev_reviewer_database_principals,jev_blind_label_reviews FROM PUBLIC,autoreply_app,autoreply_learning_worker,autoreply_admin,autoreply_jev_reviewer;
GRANT SELECT ON jev_blind_label_reviews TO autoreply_admin;
