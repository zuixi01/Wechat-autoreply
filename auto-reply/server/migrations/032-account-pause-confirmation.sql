SET search_path=autoreply,public;
CREATE TABLE IF NOT EXISTS account_pause_requests (
  tenant_id text NOT NULL,account_id text NOT NULL,id uuid NOT NULL,actor_id text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,account_id,id), FOREIGN KEY(tenant_id,account_id) REFERENCES accounts(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS account_pause_targets (
  tenant_id text NOT NULL,account_id text NOT NULL,request_id uuid NOT NULL,agent_id text NOT NULL,
  PRIMARY KEY(tenant_id,account_id,request_id,agent_id),
  FOREIGN KEY(tenant_id,account_id,request_id) REFERENCES account_pause_requests(tenant_id,account_id,id),
  FOREIGN KEY(tenant_id,agent_id,account_id) REFERENCES agents(tenant_id,id,account_id)
);
CREATE TABLE IF NOT EXISTS account_pause_heads (
  tenant_id text NOT NULL,account_id text NOT NULL,request_id uuid NOT NULL,
  PRIMARY KEY(tenant_id,account_id),
  FOREIGN KEY(tenant_id,account_id,request_id) REFERENCES account_pause_requests(tenant_id,account_id,id)
);
CREATE TABLE IF NOT EXISTS account_pause_challenges (
  tenant_id text NOT NULL,account_id text NOT NULL,request_id uuid NOT NULL,agent_id text NOT NULL,
  id uuid NOT NULL,attempt_id uuid NOT NULL,challenge_hash text NOT NULL CHECK(challenge_hash ~ '^[a-f0-9]{64}$'),
  challenge_json jsonb NOT NULL CHECK(jsonb_typeof(challenge_json)='object' AND octet_length(challenge_json::text)<=8192),
  issued_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
  PRIMARY KEY(tenant_id,account_id,id),UNIQUE(tenant_id,account_id,id,request_id,agent_id),
  UNIQUE(tenant_id,account_id,request_id,agent_id,attempt_id),
  CHECK(expires_at-issued_at=interval '30 seconds'),
  FOREIGN KEY(tenant_id,account_id,request_id,agent_id) REFERENCES account_pause_targets(tenant_id,account_id,request_id,agent_id)
);
CREATE TABLE IF NOT EXISTS account_pause_reports (
  tenant_id text NOT NULL,account_id text NOT NULL,request_id uuid NOT NULL,agent_id text NOT NULL,challenge_id uuid NOT NULL,
  report_hash text NOT NULL CHECK(report_hash ~ '^[a-f0-9]{64}$'),
  report_json jsonb NOT NULL CHECK(jsonb_typeof(report_json)='object' AND octet_length(report_json::text)<=8192),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,account_id,challenge_id),
  FOREIGN KEY(tenant_id,account_id,challenge_id,request_id,agent_id) REFERENCES account_pause_challenges(tenant_id,account_id,id,request_id,agent_id)
);
CREATE INDEX IF NOT EXISTS account_pause_reports_latest ON account_pause_reports(tenant_id,account_id,request_id,agent_id,received_at DESC,challenge_id DESC);
CREATE OR REPLACE FUNCTION autoreply.account_pause_history_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,autoreply AS $$ BEGIN RAISE EXCEPTION 'account_pause_history_immutable'; END $$;
REVOKE ALL ON FUNCTION autoreply.account_pause_history_immutable() FROM PUBLIC;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['account_pause_requests','account_pause_targets','account_pause_heads','account_pause_challenges','account_pause_reports'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename=t AND policyname='tenant_scope') THEN
      EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=(SELECT current_setting(''app.tenant_id'',true))) WITH CHECK(tenant_id=(SELECT current_setting(''app.tenant_id'',true)))',t);
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename=t AND policyname='admin_login_scope') THEN
      EXECUTE format('CREATE POLICY admin_login_scope ON %I AS RESTRICTIVE TO autoreply_admin USING(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id))) WITH CHECK(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id)))',t);
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename=t AND policyname='pause_device_scope') THEN
      IF t IN ('account_pause_requests','account_pause_heads') THEN
        EXECUTE format('CREATE POLICY pause_device_scope ON %I AS RESTRICTIVE TO autoreply_app USING(account_id=current_setting(''app.pause_account_id'',true) AND EXISTS(SELECT 1 FROM account_pause_targets p WHERE p.tenant_id=%I.tenant_id AND p.account_id=%I.account_id AND p.request_id=%I.%I AND p.agent_id=current_setting(''app.pause_agent_id'',true))) WITH CHECK(false)',t,t,t,t,CASE WHEN t='account_pause_requests' THEN 'id' ELSE 'request_id' END);
      ELSE
        EXECUTE format('CREATE POLICY pause_device_scope ON %I AS RESTRICTIVE TO autoreply_app USING(account_id=current_setting(''app.pause_account_id'',true) AND agent_id=current_setting(''app.pause_agent_id'',true)) WITH CHECK(account_id=current_setting(''app.pause_account_id'',true) AND agent_id=current_setting(''app.pause_agent_id'',true))',t);
      END IF;
    END IF;
    IF t<>'account_pause_heads' THEN
      EXECUTE format('DROP TRIGGER IF EXISTS account_pause_history_immutable ON %I',t);
      EXECUTE format('CREATE TRIGGER account_pause_history_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION autoreply.account_pause_history_immutable()',t);
    END IF;
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,autoreply_app,autoreply_admin',t);
  END LOOP;
END $$;
GRANT SELECT ON account_pause_requests,account_pause_targets,account_pause_heads,account_pause_challenges,account_pause_reports TO autoreply_app,autoreply_admin;
GRANT INSERT ON account_pause_requests,account_pause_targets TO autoreply_admin;
GRANT INSERT,UPDATE ON account_pause_heads TO autoreply_admin;
GRANT INSERT ON account_pause_challenges,account_pause_reports TO autoreply_app;
