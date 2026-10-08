SET search_path=autoreply,public;
CREATE TABLE IF NOT EXISTS learning_validation_runs (
  tenant_id text NOT NULL,account_id text NOT NULL,conversation_id text NOT NULL DEFAULT '',id uuid NOT NULL,
  claim_token uuid NOT NULL,source_id text NOT NULL,worker_id text NOT NULL,
  state text NOT NULL CHECK(state IN ('running','completed','failed','cancelled','timed_out')),
  lease_until bigint NOT NULL,created_at bigint NOT NULL,foreground_revision bigint NOT NULL,
  PRIMARY KEY(tenant_id,account_id,id),UNIQUE(tenant_id,account_id,claim_token),
  FOREIGN KEY(tenant_id,account_id) REFERENCES accounts(tenant_id,id)
);
ALTER TABLE learning_validation_runs ADD COLUMN IF NOT EXISTS finished_at bigint;
ALTER TABLE learning_attempts ADD COLUMN IF NOT EXISTS validation_run_id uuid;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='learning_attempt_validation_run' AND conrelid='autoreply.learning_attempts'::regclass) THEN
    ALTER TABLE learning_attempts ADD CONSTRAINT learning_attempt_validation_run FOREIGN KEY(tenant_id,account_id,validation_run_id)
      REFERENCES learning_validation_runs(tenant_id,account_id,id) ON DELETE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS learning_validation_run_source ON learning_validation_runs(tenant_id,account_id,conversation_id,source_id);
ALTER TABLE learning_validation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_validation_runs FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename='learning_validation_runs' AND policyname='validation_run_scope') THEN
    CREATE POLICY validation_run_scope ON learning_validation_runs USING(tenant_id=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id=current_setting('app.tenant_id',true));
    CREATE POLICY validation_run_account_scope ON learning_validation_runs AS RESTRICTIVE TO autoreply_app
      USING(account_id=current_setting('app.learning_account_id',true)) WITH CHECK(account_id=current_setting('app.learning_account_id',true));
    CREATE POLICY validation_run_admin_scope ON learning_validation_runs AS RESTRICTIVE TO autoreply_admin
      USING(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id))) WITH CHECK(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id)));
  END IF;
END $$;
-- Account cancellation/forgetting/reclamation can stop a run; none can create a grant.
GRANT SELECT,UPDATE,DELETE ON learning_validation_runs TO autoreply_app;
GRANT INSERT ON learning_validation_runs TO autoreply_learning_worker;
GRANT SELECT ON learning_validation_runs TO autoreply_admin;
