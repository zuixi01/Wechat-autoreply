SET search_path=autoreply,public;
CREATE TABLE IF NOT EXISTS ledger_restore_challenges (
  tenant_id text NOT NULL,account_id text NOT NULL,id uuid NOT NULL,case_id uuid NOT NULL,
  agent_id text NOT NULL,request_id uuid NOT NULL,challenge_hash text NOT NULL CHECK(challenge_hash ~ '^[a-f0-9]{64}$'),
  challenge_json jsonb NOT NULL CHECK(jsonb_typeof(challenge_json)='object'),
  issued_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
  PRIMARY KEY(tenant_id,account_id,id),UNIQUE(tenant_id,account_id,case_id,request_id),
  UNIQUE(tenant_id,account_id,id,agent_id),
  CHECK(expires_at>issued_at AND expires_at-issued_at=interval '30 seconds'),
  FOREIGN KEY(tenant_id,account_id,case_id) REFERENCES ledger_restore_reviews(tenant_id,account_id,id),
  FOREIGN KEY(tenant_id,agent_id,account_id) REFERENCES agents(tenant_id,id,account_id)
);
CREATE TABLE IF NOT EXISTS ledger_restore_pause_reports (
  tenant_id text NOT NULL,account_id text NOT NULL,challenge_id uuid NOT NULL,agent_id text NOT NULL,
  report_hash text NOT NULL CHECK(report_hash ~ '^[a-f0-9]{64}$'),
  report_json jsonb NOT NULL CHECK(jsonb_typeof(report_json)='object'),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,account_id,challenge_id),
  FOREIGN KEY(tenant_id,account_id,challenge_id,agent_id) REFERENCES ledger_restore_challenges(tenant_id,account_id,id,agent_id)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['ledger_restore_reviews','ledger_restore_review_permits','ledger_restore_challenges','ledger_restore_pause_reports'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename=t AND policyname='tenant_scope') THEN
      EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=current_setting(''app.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''app.tenant_id'',true))',t);
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename=t AND policyname='restore_device_scope') THEN
      IF t='ledger_restore_review_permits' THEN
        EXECUTE format('CREATE POLICY restore_device_scope ON %I AS RESTRICTIVE TO autoreply_app USING(account_id=current_setting(''app.restore_account_id'',true) AND EXISTS(SELECT 1 FROM ledger_restore_reviews r WHERE (r.tenant_id,r.account_id,r.id)=(ledger_restore_review_permits.tenant_id,ledger_restore_review_permits.account_id,ledger_restore_review_permits.case_id) AND r.agent_id=current_setting(''app.restore_agent_id'',true))) WITH CHECK(false)',t);
      ELSE
        EXECUTE format('CREATE POLICY restore_device_scope ON %I AS RESTRICTIVE TO autoreply_app USING(account_id=current_setting(''app.restore_account_id'',true) AND agent_id=current_setting(''app.restore_agent_id'',true)) WITH CHECK(account_id=current_setting(''app.restore_account_id'',true) AND agent_id=current_setting(''app.restore_agent_id'',true))',t);
      END IF;
    END IF;
    IF t IN ('ledger_restore_challenges','ledger_restore_pause_reports') AND NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename=t AND policyname='admin_login_scope') THEN
      EXECUTE format('CREATE POLICY admin_login_scope ON %I AS RESTRICTIVE TO autoreply_admin USING(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id))) WITH CHECK(false)',t);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON ledger_restore_challenges,ledger_restore_pause_reports FROM PUBLIC,autoreply_learning_worker;
GRANT SELECT ON ledger_restore_reviews,ledger_restore_review_permits TO autoreply_app;
GRANT SELECT,INSERT ON ledger_restore_challenges,ledger_restore_pause_reports TO autoreply_app;
GRANT SELECT ON ledger_restore_challenges,ledger_restore_pause_reports TO autoreply_admin;
-- Append-only declarations from the authenticated target; no release or physical stop proof.
