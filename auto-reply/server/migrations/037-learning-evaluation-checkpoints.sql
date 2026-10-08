SET search_path=autoreply,public;
-- Held-out evidence is separate from learning episodes, calibrations and activation grants.
CREATE TABLE IF NOT EXISTS learning_evaluation_checkpoints (
  tenant_id text NOT NULL, account_id text NOT NULL, run_id uuid NOT NULL,
  scope jsonb NOT NULL, basis jsonb NOT NULL, frozen jsonb NOT NULL, basis_hash text NOT NULL,
  state text NOT NULL CHECK(state IN ('collecting','waiting_budget','completed','incomplete')),
  created_at bigint NOT NULL, expires_at bigint NOT NULL,
  PRIMARY KEY(tenant_id,account_id,run_id),
  FOREIGN KEY(tenant_id,account_id,run_id) REFERENCES learning_validation_runs(tenant_id,account_id,id) ON DELETE CASCADE,
  CHECK(jsonb_typeof(scope)='object' AND jsonb_typeof(basis)='object' AND jsonb_typeof(frozen)='object'),
  CHECK(octet_length(basis::text)<=33554432)
);
CREATE TABLE IF NOT EXISTS learning_evaluation_arms (
  tenant_id text NOT NULL, account_id text NOT NULL, run_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK(ordinal>=0 AND ordinal<6000),
  assignment_id uuid NOT NULL, case_id text NOT NULL, arm text NOT NULL CHECK(arm IN ('none','baseline','learned')),
  state text NOT NULL CHECK(state IN ('pending','running','completed')), receipt jsonb,
  PRIMARY KEY(tenant_id,account_id,run_id,ordinal),
  UNIQUE(tenant_id,account_id,run_id,case_id,arm), UNIQUE(tenant_id,account_id,assignment_id),
  FOREIGN KEY(tenant_id,account_id,run_id) REFERENCES learning_evaluation_checkpoints(tenant_id,account_id,run_id) ON DELETE CASCADE,
  CHECK((state='completed')=(receipt IS NOT NULL)),
  CHECK(receipt IS NULL OR (jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=131072))
);
CREATE INDEX IF NOT EXISTS learning_evaluation_expiry ON learning_evaluation_checkpoints(tenant_id,account_id,expires_at);
DO $$ DECLARE item text; BEGIN
  FOREACH item IN ARRAY ARRAY['learning_evaluation_checkpoints','learning_evaluation_arms'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',item);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',item);
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename=item AND policyname='evaluation_checkpoint_tenant') THEN
      EXECUTE format('CREATE POLICY evaluation_checkpoint_tenant ON %I USING(tenant_id=current_setting(''app.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''app.tenant_id'',true))',item);
      EXECUTE format('CREATE POLICY evaluation_checkpoint_account ON %I AS RESTRICTIVE TO autoreply_app USING(account_id=current_setting(''app.learning_account_id'',true)) WITH CHECK(account_id=current_setting(''app.learning_account_id'',true))',item);
      EXECUTE format('CREATE POLICY evaluation_checkpoint_admin ON %I AS RESTRICTIVE TO autoreply_admin USING(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id))) WITH CHECK(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id)))',item);
      EXECUTE format('CREATE POLICY evaluation_checkpoint_worker ON %I AS RESTRICTIVE TO autoreply_learning_worker USING(EXISTS(SELECT 1 FROM autoreply.learning_worker_references() r CROSS JOIN LATERAL autoreply.authenticate_learning_worker(r.id,false) s WHERE s.tenant_id=%I.tenant_id AND s.account_id=%I.account_id)) WITH CHECK(EXISTS(SELECT 1 FROM autoreply.learning_worker_references() r CROSS JOIN LATERAL autoreply.authenticate_learning_worker(r.id,false) s WHERE s.tenant_id=%I.tenant_id AND s.account_id=%I.account_id))',item,item,item,item,item);
    END IF;
    -- Device accounts can erase evidence, but cannot read, create or rewrite frozen results.
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO autoreply_learning_worker',item);
    EXECUTE format('GRANT DELETE ON %I TO autoreply_app',item);
    EXECUTE format('GRANT SELECT ON %I TO autoreply_admin',item);
  END LOOP;
END $$;
-- Filtering an authenticated deletion needs these columns, never the private bodies.
GRANT SELECT(tenant_id,account_id,run_id,expires_at) ON learning_evaluation_checkpoints TO autoreply_app;
