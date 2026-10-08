SET search_path=autoreply,public;
CREATE TABLE IF NOT EXISTS learning_curation_state (
  tenant_id text NOT NULL,account_id text NOT NULL,conversation_id text NOT NULL DEFAULT '',
  observed_at bigint,last_run_at bigint,last_retention_at bigint,
  PRIMARY KEY(tenant_id,account_id,conversation_id),
  FOREIGN KEY(tenant_id,account_id) REFERENCES accounts(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS learning_curation_reports (
  tenant_id text NOT NULL,account_id text NOT NULL,conversation_id text NOT NULL DEFAULT '',
  id uuid NOT NULL,created_at bigint NOT NULL,payload jsonb NOT NULL,
  PRIMARY KEY(tenant_id,account_id,id),
  FOREIGN KEY(tenant_id,account_id) REFERENCES accounts(tenant_id,id)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['learning_curation_state','learning_curation_reports'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename=t AND policyname='maintenance_scope') THEN
      EXECUTE format('CREATE POLICY maintenance_scope ON %I USING(tenant_id=current_setting(''app.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''app.tenant_id'',true))',t);
      EXECUTE format('CREATE POLICY maintenance_account_scope ON %I AS RESTRICTIVE TO autoreply_app USING(account_id=current_setting(''app.learning_account_id'',true)) WITH CHECK(account_id=current_setting(''app.learning_account_id'',true))',t);
      EXECUTE format('CREATE POLICY maintenance_admin_scope ON %I AS RESTRICTIVE TO autoreply_admin USING(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id))) WITH CHECK(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id)))',t);
    END IF;
    EXECUTE format('GRANT SELECT,DELETE ON %I TO autoreply_app',t);
    EXECUTE format('GRANT SELECT ON %I TO autoreply_admin',t);
    EXECUTE format('GRANT INSERT,UPDATE,DELETE ON %I TO autoreply_learning_worker',t);
  END LOOP;
END $$;
