SET search_path=autoreply,public;
ALTER TABLE learning_evaluation_checkpoints ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 1 CHECK(attempt_count BETWEEN 1 AND 3);
ALTER TABLE learning_evaluation_checkpoints ADD COLUMN IF NOT EXISTS resume_at bigint NOT NULL DEFAULT 0;
ALTER TABLE learning_evaluation_arms ADD COLUMN IF NOT EXISTS active_ms double precision NOT NULL DEFAULT 0 CHECK(active_ms>=0 AND active_ms<'Infinity'::double precision);
ALTER TABLE learning_evaluation_arms ADD COLUMN IF NOT EXISTS timing_complete boolean NOT NULL DEFAULT true;
CREATE UNIQUE INDEX IF NOT EXISTS learning_evaluation_arm_batch_assignment ON learning_evaluation_arms(tenant_id,account_id,run_id,assignment_id);
CREATE TABLE IF NOT EXISTS learning_evaluation_stages (
 tenant_id text NOT NULL,account_id text NOT NULL,run_id uuid NOT NULL,assignment_id uuid NOT NULL,
 stage text NOT NULL CHECK(stage IN ('pre','text','post')),result jsonb NOT NULL,
 model_call_refs uuid[] NOT NULL CHECK(cardinality(model_call_refs)=1),created_at bigint NOT NULL,
 PRIMARY KEY(tenant_id,account_id,run_id,assignment_id,stage),
 FOREIGN KEY(tenant_id,account_id,run_id,assignment_id) REFERENCES learning_evaluation_arms(tenant_id,account_id,run_id,assignment_id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,account_id,run_id) REFERENCES learning_evaluation_checkpoints(tenant_id,account_id,run_id) ON DELETE CASCADE,
 CHECK(jsonb_typeof(result)='object' AND octet_length(result::text)<=2097152)
);
ALTER TABLE learning_evaluation_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_evaluation_stages FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename='learning_evaluation_stages' AND policyname='evaluation_checkpoint_tenant') THEN
  CREATE POLICY evaluation_checkpoint_tenant ON learning_evaluation_stages USING(tenant_id=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id=current_setting('app.tenant_id',true));
  CREATE POLICY evaluation_checkpoint_account ON learning_evaluation_stages AS RESTRICTIVE TO autoreply_app USING(account_id=current_setting('app.learning_account_id',true)) WITH CHECK(account_id=current_setting('app.learning_account_id',true));
  CREATE POLICY evaluation_checkpoint_admin ON learning_evaluation_stages AS RESTRICTIVE TO autoreply_admin USING(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id))) WITH CHECK(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id)));
  CREATE POLICY evaluation_checkpoint_worker ON learning_evaluation_stages AS RESTRICTIVE TO autoreply_learning_worker USING(EXISTS(SELECT 1 FROM autoreply.learning_worker_references() r CROSS JOIN LATERAL autoreply.authenticate_learning_worker(r.id,false) s WHERE s.tenant_id=learning_evaluation_stages.tenant_id AND s.account_id=learning_evaluation_stages.account_id)) WITH CHECK(EXISTS(SELECT 1 FROM autoreply.learning_worker_references() r CROSS JOIN LATERAL autoreply.authenticate_learning_worker(r.id,false) s WHERE s.tenant_id=learning_evaluation_stages.tenant_id AND s.account_id=learning_evaluation_stages.account_id));
 END IF;
END $$;
GRANT SELECT,INSERT,UPDATE,DELETE ON learning_evaluation_stages TO autoreply_learning_worker;
GRANT DELETE ON learning_evaluation_stages TO autoreply_app;
GRANT SELECT ON learning_evaluation_stages TO autoreply_admin;
