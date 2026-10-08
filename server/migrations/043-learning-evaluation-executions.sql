SET search_path=autoreply,public;
-- Execution task metadata, separate from learning/generation inputs and sending permits.
CREATE TABLE IF NOT EXISTS learning_evaluation_execution_tasks (
 tenant_id text NOT NULL,account_id text NOT NULL,run_id uuid NOT NULL,assignment_id uuid NOT NULL,
 task_hash text NOT NULL CHECK(task_hash~'^[0-9a-f]{64}$'),task jsonb NOT NULL,created_at bigint NOT NULL,
 PRIMARY KEY(tenant_id,account_id,run_id,assignment_id,task_hash),
 FOREIGN KEY(tenant_id,account_id,run_id,assignment_id) REFERENCES learning_evaluation_arms(tenant_id,account_id,run_id,assignment_id) ON DELETE CASCADE,
 CHECK(jsonb_typeof(task)='object' AND octet_length(task::text)<=16384)
);
ALTER TABLE learning_evaluation_stages ADD COLUMN IF NOT EXISTS execution_task_hash text;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='evaluation_stage_execution_task' AND conrelid='learning_evaluation_stages'::regclass) THEN
  ALTER TABLE learning_evaluation_stages ADD CONSTRAINT evaluation_stage_execution_task
   FOREIGN KEY(tenant_id,account_id,run_id,assignment_id,execution_task_hash)
   REFERENCES learning_evaluation_execution_tasks(tenant_id,account_id,run_id,assignment_id,task_hash) ON DELETE CASCADE;
 END IF;
END $$;
ALTER TABLE learning_evaluation_execution_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_evaluation_execution_tasks FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename='learning_evaluation_execution_tasks' AND policyname='evaluation_execution_tenant') THEN
  CREATE POLICY evaluation_execution_tenant ON learning_evaluation_execution_tasks USING(tenant_id=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id=current_setting('app.tenant_id',true));
  CREATE POLICY evaluation_execution_account ON learning_evaluation_execution_tasks AS RESTRICTIVE TO autoreply_app USING(account_id=current_setting('app.learning_account_id',true)) WITH CHECK(account_id=current_setting('app.learning_account_id',true));
  CREATE POLICY evaluation_execution_admin ON learning_evaluation_execution_tasks AS RESTRICTIVE TO autoreply_admin USING(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id))) WITH CHECK(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id)));
  CREATE POLICY evaluation_execution_worker ON learning_evaluation_execution_tasks AS RESTRICTIVE TO autoreply_learning_worker USING(EXISTS(SELECT 1 FROM autoreply.learning_worker_references() r CROSS JOIN LATERAL autoreply.authenticate_learning_worker(r.id,false) s WHERE s.tenant_id=learning_evaluation_execution_tasks.tenant_id AND s.account_id=learning_evaluation_execution_tasks.account_id)) WITH CHECK(EXISTS(SELECT 1 FROM autoreply.learning_worker_references() r CROSS JOIN LATERAL autoreply.authenticate_learning_worker(r.id,false) s WHERE s.tenant_id=learning_evaluation_execution_tasks.tenant_id AND s.account_id=learning_evaluation_execution_tasks.account_id));
 END IF;
END $$;
GRANT SELECT,INSERT,DELETE ON learning_evaluation_execution_tasks TO autoreply_learning_worker;
GRANT DELETE ON learning_evaluation_execution_tasks TO autoreply_app;
GRANT SELECT ON learning_evaluation_execution_tasks TO autoreply_admin;
