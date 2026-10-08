SET search_path=autoreply,public;
-- Only the trusted evaluation runner finalizes results. This table stores no draft text.
CREATE TABLE IF NOT EXISTS jev_replay_artifact_seals (
  tenant_id text NOT NULL,account_id text NOT NULL,assignment_id uuid NOT NULL,
  artifact_hash text NOT NULL CHECK(artifact_hash ~ '^[a-f0-9]{64}$'),
  ledger_hash text NOT NULL CHECK(ledger_hash ~ '^[a-f0-9]{64}$'),
  attempt_count integer NOT NULL CHECK(attempt_count BETWEEN 0 AND 100),
  sealed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,account_id,assignment_id),
  FOREIGN KEY(tenant_id,account_id,assignment_id) REFERENCES jev_replay_assignments(tenant_id,account_id,id)
);
CREATE OR REPLACE FUNCTION autoreply.jev_replay_seal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,autoreply AS $$
DECLARE actor text; e jev_replay_executions; n integer;
BEGIN
  SELECT actor_id INTO actor FROM autoreply.authenticate_admin(NEW.tenant_id);
  IF actor IS NULL THEN RAISE EXCEPTION 'jev_replay_seal_denied'; END IF;
  PERFORM 1 FROM accounts WHERE (tenant_id,id)=(NEW.tenant_id,NEW.account_id) FOR UPDATE;
  SELECT x.* INTO e FROM jev_replay_assignments s JOIN jev_replay_executions x
    ON (x.tenant_id,x.account_id,x.id)=(s.tenant_id,s.account_id,s.execution_id)
    WHERE (s.tenant_id,s.account_id,s.id)=(NEW.tenant_id,NEW.account_id,NEW.assignment_id);
  IF NOT FOUND OR e.actor_id<>actor OR e.login_name<>session_user THEN RAISE EXCEPTION 'jev_replay_seal_denied'; END IF;
  IF TG_TABLE_NAME='jev_replay_attempts' THEN
    IF EXISTS(SELECT 1 FROM jev_replay_artifact_seals WHERE (tenant_id,account_id,assignment_id)=(NEW.tenant_id,NEW.account_id,NEW.assignment_id)) THEN
      RAISE EXCEPTION 'jev_replay_assignment_sealed'; END IF;
    RETURN NEW;
  END IF;
  SELECT count(*) INTO n FROM jev_replay_attempts WHERE (tenant_id,account_id,assignment_id)=(NEW.tenant_id,NEW.account_id,NEW.assignment_id);
  IF n<>NEW.attempt_count OR EXISTS(SELECT 1 FROM jev_replay_attempts t LEFT JOIN jev_replay_results r
    ON (r.tenant_id,r.account_id,r.attempt_id)=(t.tenant_id,t.account_id,t.id)
    WHERE (t.tenant_id,t.account_id,t.assignment_id)=(NEW.tenant_id,NEW.account_id,NEW.assignment_id) AND r.attempt_id IS NULL) THEN
    RAISE EXCEPTION 'jev_replay_seal_incomplete'; END IF;
  NEW.sealed_at:=clock_timestamp(); RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION autoreply.jev_replay_seal_guard() FROM PUBLIC;
ALTER TABLE jev_replay_artifact_seals ENABLE ROW LEVEL SECURITY;
ALTER TABLE jev_replay_artifact_seals FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename='jev_replay_artifact_seals' AND policyname='tenant_scope') THEN
    CREATE POLICY tenant_scope ON jev_replay_artifact_seals USING(tenant_id=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id=current_setting('app.tenant_id',true));
    CREATE POLICY admin_login_scope ON jev_replay_artifact_seals AS RESTRICTIVE TO autoreply_admin
      USING(tenant_id=current_setting('app.tenant_id',true) AND EXISTS(SELECT 1 FROM autoreply.authenticate_admin(current_setting('app.tenant_id',true)))) WITH CHECK(tenant_id=current_setting('app.tenant_id',true) AND EXISTS(SELECT 1 FROM autoreply.authenticate_admin(current_setting('app.tenant_id',true))));
  END IF;
END $$;
DROP TRIGGER IF EXISTS jev_replay_seal_guard ON jev_replay_artifact_seals;
CREATE TRIGGER jev_replay_seal_guard BEFORE INSERT ON jev_replay_artifact_seals FOR EACH ROW EXECUTE FUNCTION autoreply.jev_replay_seal_guard();
DROP TRIGGER IF EXISTS jev_replay_seal_immutable ON jev_replay_artifact_seals;
CREATE TRIGGER jev_replay_seal_immutable BEFORE UPDATE OR DELETE ON jev_replay_artifact_seals FOR EACH ROW EXECUTE FUNCTION autoreply.jev_replay_immutable();
DROP TRIGGER IF EXISTS jev_replay_assignment_closed ON jev_replay_attempts;
CREATE TRIGGER jev_replay_assignment_closed BEFORE INSERT ON jev_replay_attempts FOR EACH ROW EXECUTE FUNCTION autoreply.jev_replay_seal_guard();
REVOKE ALL ON jev_replay_artifact_seals FROM PUBLIC,autoreply_app,autoreply_learning_worker,autoreply_admin;
GRANT SELECT,INSERT ON jev_replay_artifact_seals TO autoreply_admin;
