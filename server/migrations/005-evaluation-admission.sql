SET search_path=autoreply,public;
CREATE TABLE IF NOT EXISTS evaluation_runs (
  tenant_id text NOT NULL,account_id text NOT NULL,id text NOT NULL,
  snapshot_hash text NOT NULL,publication_json jsonb NOT NULL,plan_json jsonb NOT NULL,
  created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 days',
  PRIMARY KEY(tenant_id,account_id,id),
  FOREIGN KEY(tenant_id,account_id) REFERENCES accounts(tenant_id,id),
  FOREIGN KEY(tenant_id,created_by) REFERENCES employees(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS evaluation_approvals (
  tenant_id text NOT NULL,account_id text NOT NULL,id text NOT NULL,run_id text NOT NULL,
  snapshot_hash text NOT NULL,dataset_hash text NOT NULL,report_hash text NOT NULL,report_json jsonb NOT NULL,
  approved_by text NOT NULL,adjudicated_by text NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY(tenant_id,account_id,id),UNIQUE(tenant_id,account_id,run_id),
  FOREIGN KEY(tenant_id,account_id,run_id) REFERENCES evaluation_runs(tenant_id,account_id,id),
  FOREIGN KEY(tenant_id,approved_by) REFERENCES employees(tenant_id,id),
  FOREIGN KEY(tenant_id,adjudicated_by) REFERENCES employees(tenant_id,id),
  CHECK(approved_by<>adjudicated_by)
);
ALTER TABLE generation_publications ADD COLUMN IF NOT EXISTS evaluation_approval_id text;
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['evaluation_runs','evaluation_approvals'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename=table_name AND policyname='tenant_scope') THEN
      EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=current_setting(''app.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''app.tenant_id'',true))',table_name);
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename=table_name AND policyname='admin_login_scope') THEN
      EXECUTE format('CREATE POLICY admin_login_scope ON %I AS RESTRICTIVE TO autoreply_admin USING(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id))) WITH CHECK(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id)))',table_name);
    END IF;
  END LOOP;
END $$;
GRANT SELECT ON evaluation_runs,evaluation_approvals TO autoreply_app;
GRANT SELECT,INSERT ON evaluation_runs,evaluation_approvals TO autoreply_admin;
GRANT UPDATE(revoked_at) ON evaluation_approvals TO autoreply_admin;
CREATE OR REPLACE FUNCTION autoreply.keep_evaluation_revoked()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'evaluation_revocation_is_final';
  END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='evaluation_revocation_final'
    AND tgrelid='autoreply.evaluation_approvals'::regclass) THEN
    CREATE TRIGGER evaluation_revocation_final BEFORE UPDATE ON evaluation_approvals
      FOR EACH ROW EXECUTE FUNCTION autoreply.keep_evaluation_revoked();
  END IF;
END $$;
-- No employee/device can approve, change a frozen run, or undo revocation.
