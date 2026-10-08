SET search_path=autoreply,public;
CREATE TABLE IF NOT EXISTS device_runtime_status (
  tenant_id text NOT NULL, agent_id text NOT NULL, account_id text NOT NULL,
  runtime_epoch bigint NOT NULL CHECK(runtime_epoch>0 AND runtime_epoch<=9007199254740991),
  sequence bigint NOT NULL CHECK(sequence>0 AND sequence<=9007199254740991),
  report_hash text NOT NULL CHECK(report_hash ~ '^[a-f0-9]{64}$'),
  report_json jsonb NOT NULL CHECK(jsonb_typeof(report_json)='object' AND octet_length(report_json::text)<=8192),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,agent_id),
  FOREIGN KEY(tenant_id,agent_id,account_id) REFERENCES agents(tenant_id,id,account_id)
);
CREATE INDEX IF NOT EXISTS agents_runtime_pagination ON agents(tenant_id,account_id COLLATE "C",id COLLATE "C");
ALTER TABLE device_runtime_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_runtime_status FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename='device_runtime_status' AND policyname='tenant_scope') THEN
    CREATE POLICY tenant_scope ON device_runtime_status
      USING(tenant_id=(SELECT current_setting('app.tenant_id',true)))
      WITH CHECK(tenant_id=(SELECT current_setting('app.tenant_id',true)));
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename='device_runtime_status' AND policyname='admin_login_scope') THEN
    CREATE POLICY admin_login_scope ON device_runtime_status AS RESTRICTIVE TO autoreply_admin
      USING(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id)))
      WITH CHECK(false);
  END IF;
END $$;
REVOKE ALL ON device_runtime_status FROM PUBLIC,autoreply_admin;
GRANT SELECT,INSERT,UPDATE ON device_runtime_status TO autoreply_app;
GRANT SELECT ON device_runtime_status TO autoreply_admin;
