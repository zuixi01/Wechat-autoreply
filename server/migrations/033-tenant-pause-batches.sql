SET search_path=autoreply,public;
CREATE TABLE IF NOT EXISTS tenant_pause_batches (
  tenant_id text NOT NULL REFERENCES tenants(id),id uuid NOT NULL,actor_id text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS tenant_pause_accounts (
  tenant_id text NOT NULL,batch_id uuid NOT NULL,account_id text NOT NULL,request_id uuid NOT NULL,
  PRIMARY KEY(tenant_id,batch_id,account_id),UNIQUE(tenant_id,account_id,request_id),
  FOREIGN KEY(tenant_id,batch_id) REFERENCES tenant_pause_batches(tenant_id,id),
  FOREIGN KEY(tenant_id,account_id,request_id) REFERENCES account_pause_requests(tenant_id,account_id,id)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_pause_batches','tenant_pause_accounts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename=t AND policyname='tenant_scope') THEN
      EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=(SELECT current_setting(''app.tenant_id'',true))) WITH CHECK(tenant_id=(SELECT current_setting(''app.tenant_id'',true)))',t);
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename=t AND policyname='admin_login_scope') THEN
      EXECUTE format('CREATE POLICY admin_login_scope ON %I AS RESTRICTIVE TO autoreply_admin USING(tenant_id=(SELECT tenant_id FROM autoreply.authenticate_admin((SELECT current_setting(''app.tenant_id'',true))))) WITH CHECK(tenant_id=(SELECT tenant_id FROM autoreply.authenticate_admin((SELECT current_setting(''app.tenant_id'',true)))))',t);
    END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS tenant_pause_history_immutable ON %I',t);
    EXECUTE format('CREATE TRIGGER tenant_pause_history_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION autoreply.account_pause_history_immutable()',t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,autoreply_app,autoreply_admin',t);
  END LOOP;
END $$;
GRANT SELECT,INSERT ON tenant_pause_batches,tenant_pause_accounts TO autoreply_admin;
