SET search_path=autoreply,public;
CREATE TABLE IF NOT EXISTS ledger_restore_application_acks (
 tenant_id text NOT NULL,account_id text NOT NULL,case_id uuid NOT NULL,agent_id text NOT NULL,
 application_id uuid NOT NULL,decision_id uuid NOT NULL,application_hash text NOT NULL CHECK(application_hash ~ '^[a-f0-9]{64}$'),
 application_json jsonb NOT NULL CHECK(jsonb_typeof(application_json)='object'),
 ack_hash text NOT NULL CHECK(ack_hash ~ '^[a-f0-9]{64}$'),ack_json jsonb NOT NULL CHECK(jsonb_typeof(ack_json)='object'),
 recorded_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,account_id,case_id,application_id),
 UNIQUE(tenant_id,account_id,case_id,decision_id),
 FOREIGN KEY(tenant_id,account_id,case_id,decision_id) REFERENCES ledger_restore_decisions(tenant_id,account_id,case_id,decision_id),
 FOREIGN KEY(tenant_id,agent_id,account_id) REFERENCES agents(tenant_id,id,account_id)
);
ALTER TABLE ledger_restore_application_acks ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_restore_application_acks FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename='ledger_restore_application_acks' AND policyname='tenant_scope') THEN
  CREATE POLICY tenant_scope ON ledger_restore_application_acks USING(tenant_id=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id=current_setting('app.tenant_id',true));
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename='ledger_restore_application_acks' AND policyname='restore_device_scope') THEN
  CREATE POLICY restore_device_scope ON ledger_restore_application_acks AS RESTRICTIVE TO autoreply_app
  USING(account_id=current_setting('app.restore_account_id',true) AND agent_id=current_setting('app.restore_agent_id',true))
  WITH CHECK(account_id=current_setting('app.restore_account_id',true) AND agent_id=current_setting('app.restore_agent_id',true));
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename='ledger_restore_application_acks' AND policyname='admin_login_scope') THEN
  CREATE POLICY admin_login_scope ON ledger_restore_application_acks AS RESTRICTIVE TO autoreply_admin USING(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id))) WITH CHECK(false);
 END IF;
END $$;
REVOKE ALL ON ledger_restore_application_acks FROM PUBLIC,autoreply_app,autoreply_admin,autoreply_learning_worker,autoreply_restore_reader;
GRANT SELECT,INSERT ON ledger_restore_application_acks TO autoreply_app;
GRANT SELECT ON ledger_restore_application_acks TO autoreply_admin;
-- Append-only quarantine declarations. Pause/resume and independent reconciliation guards remain required.
