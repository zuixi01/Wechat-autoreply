SET search_path=autoreply,public;
-- Hashes bind the private packet, not independent human identity or billing.
CREATE TABLE IF NOT EXISTS jev_blind_packet_seals (
  tenant_id text NOT NULL,account_id text NOT NULL,packet_id uuid NOT NULL,execution_id uuid NOT NULL,run_id text NOT NULL,
  packet_hash text NOT NULL CHECK(packet_hash ~ '^[a-f0-9]{64}$'),
  artifact_set_hash text NOT NULL CHECK(artifact_set_hash ~ '^[a-f0-9]{64}$'),
  actor_id text NOT NULL,login_name name NOT NULL,sealed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,account_id,packet_id),UNIQUE(tenant_id,account_id,execution_id),
  FOREIGN KEY(tenant_id,account_id,execution_id) REFERENCES jev_replay_executions(tenant_id,account_id,id),
  FOREIGN KEY(tenant_id,account_id,run_id) REFERENCES evaluation_runs(tenant_id,account_id,id)
);
CREATE OR REPLACE FUNCTION autoreply.jev_blind_packet_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,autoreply AS $$
DECLARE actor text;e jev_replay_executions;a accounts;n integer;sealed integer;actual_hash text;
BEGIN
  SELECT actor_id INTO actor FROM autoreply.authenticate_admin(NEW.tenant_id);
  IF actor IS NULL THEN RAISE EXCEPTION 'jev_blind_packet_denied'; END IF;
  SELECT * INTO a FROM accounts WHERE (tenant_id,id)=(NEW.tenant_id,NEW.account_id) FOR UPDATE;
  IF NOT FOUND OR NOT a.enabled OR NOT EXISTS(SELECT 1 FROM employees WHERE (tenant_id,id)=(a.tenant_id,a.employee_id) AND enabled) THEN
    RAISE EXCEPTION 'jev_blind_packet_account_invalid'; END IF;
  SELECT * INTO e FROM jev_replay_executions WHERE (tenant_id,account_id,id)=(NEW.tenant_id,NEW.account_id,NEW.execution_id);
  IF NOT FOUND OR e.run_id<>NEW.run_id OR e.actor_id<>actor OR e.login_name<>session_user
    OR (e.employee_id,e.platform) IS DISTINCT FROM (a.employee_id,a.platform)
    OR NOT EXISTS(SELECT 1 FROM evaluation_runs r WHERE (r.tenant_id,r.account_id,r.id)=(e.tenant_id,e.account_id,e.run_id)
      AND r.created_at<=clock_timestamp() AND r.expires_at>clock_timestamp() AND r.snapshot_hash=e.snapshot_hash
      AND r.plan_json=e.plan_json AND r.publication_json=e.publication_json AND r.plan_json->>'replayProtocol'='jev-abc-v1') THEN
    RAISE EXCEPTION 'jev_blind_packet_execution_invalid'; END IF;
  SELECT count(*),count(c.assignment_id),encode(sha256(convert_to('['||coalesce(string_agg(
    format('{"artifactHash":"%s","assignmentId":"%s"}',c.artifact_hash,s.id),',' ORDER BY s.id::text COLLATE "C"),'')||']','UTF8')),'hex')
    INTO n,sealed,actual_hash FROM jev_replay_assignments s LEFT JOIN jev_replay_artifact_seals c
      ON (c.tenant_id,c.account_id,c.assignment_id)=(s.tenant_id,s.account_id,s.id)
    WHERE (s.tenant_id,s.account_id,s.execution_id)=(e.tenant_id,e.account_id,e.id);
  IF n<>jsonb_array_length(e.input_json->'cases')*3 OR sealed<>n OR actual_hash IS DISTINCT FROM NEW.artifact_set_hash THEN
    RAISE EXCEPTION 'jev_blind_packet_artifacts_unverified'; END IF;
  NEW.actor_id:=e.actor_id;NEW.login_name:=e.login_name;NEW.sealed_at:=clock_timestamp();RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION autoreply.jev_blind_packet_guard() FROM PUBLIC;
ALTER TABLE jev_blind_packet_seals ENABLE ROW LEVEL SECURITY;
ALTER TABLE jev_blind_packet_seals FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename='jev_blind_packet_seals' AND policyname='tenant_scope') THEN
    CREATE POLICY tenant_scope ON jev_blind_packet_seals USING(tenant_id=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id=current_setting('app.tenant_id',true));
    CREATE POLICY admin_login_scope ON jev_blind_packet_seals AS RESTRICTIVE TO autoreply_admin
      USING(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id))) WITH CHECK(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id)));
  END IF;
END $$;
DROP TRIGGER IF EXISTS jev_blind_packet_guard ON jev_blind_packet_seals;
CREATE TRIGGER jev_blind_packet_guard BEFORE INSERT ON jev_blind_packet_seals FOR EACH ROW EXECUTE FUNCTION autoreply.jev_blind_packet_guard();
DROP TRIGGER IF EXISTS jev_blind_packet_immutable ON jev_blind_packet_seals;
CREATE TRIGGER jev_blind_packet_immutable BEFORE UPDATE OR DELETE ON jev_blind_packet_seals FOR EACH ROW EXECUTE FUNCTION autoreply.jev_replay_immutable();
REVOKE ALL ON jev_blind_packet_seals FROM PUBLIC,autoreply_app,autoreply_learning_worker,autoreply_admin;
GRANT SELECT,INSERT ON jev_blind_packet_seals TO autoreply_admin;
