SET search_path=autoreply,public;
CREATE TABLE IF NOT EXISTS device_reconciliation_reports (
  tenant_id text NOT NULL,account_id text NOT NULL,case_id text NOT NULL,
  agent_id text NOT NULL,snapshot_hash text NOT NULL,
  report_hash text NOT NULL CHECK(report_hash ~ '^[a-f0-9]{64}$'),
  report_json jsonb NOT NULL CHECK(jsonb_typeof(report_json)='object'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,account_id,case_id),
  FOREIGN KEY(tenant_id,account_id,case_id,snapshot_hash)
    REFERENCES reconciliation_cases(tenant_id,account_id,id,snapshot_hash),
  FOREIGN KEY(tenant_id,agent_id,account_id) REFERENCES agents(tenant_id,id,account_id)
);
ALTER TABLE device_reconciliation_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_reconciliation_reports FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename='device_reconciliation_reports' AND policyname='tenant_scope') THEN
    CREATE POLICY tenant_scope ON device_reconciliation_reports
      USING(tenant_id=current_setting('app.tenant_id',true))
      WITH CHECK(tenant_id=current_setting('app.tenant_id',true));
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename='device_reconciliation_reports' AND policyname='admin_login_scope') THEN
    CREATE POLICY admin_login_scope ON device_reconciliation_reports AS RESTRICTIVE TO autoreply_admin
      USING(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id))) WITH CHECK(false);
  END IF;
END $$;
REVOKE ALL ON device_reconciliation_reports FROM PUBLIC;
GRANT SELECT ON reconciliation_cases TO autoreply_app;
GRANT SELECT,INSERT ON device_reconciliation_reports TO autoreply_app;
GRANT SELECT ON device_reconciliation_reports TO autoreply_admin;
