SET search_path=autoreply,public;
CREATE TABLE IF NOT EXISTS learning_jobs (
  tenant_id text NOT NULL,account_id text NOT NULL,conversation_id text NOT NULL DEFAULT '',id uuid NOT NULL,
  state text NOT NULL CHECK(state IN ('pending','running','completed','failed','cancelled')),
  available_at bigint NOT NULL,lease_until bigint,claim_token uuid,payload jsonb NOT NULL,
  PRIMARY KEY(tenant_id,account_id,id),FOREIGN KEY(tenant_id,account_id) REFERENCES accounts(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS learning_jobs_ready ON learning_jobs(tenant_id,account_id,state,available_at);
CREATE TABLE IF NOT EXISTS learning_job_events (
  tenant_id text NOT NULL,account_id text NOT NULL,conversation_id text NOT NULL DEFAULT '',source_id text NOT NULL,
  input_hash text NOT NULL,job_id uuid NOT NULL,
  PRIMARY KEY(tenant_id,account_id,conversation_id,source_id),
  FOREIGN KEY(tenant_id,account_id,job_id) REFERENCES learning_jobs(tenant_id,account_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS learning_attempts (
  tenant_id text NOT NULL,account_id text NOT NULL,conversation_id text NOT NULL DEFAULT '',claim_token uuid NOT NULL,
  job_id uuid,worker_id text NOT NULL,purpose text NOT NULL CHECK(purpose IN ('review','validation','curation')),
  day date NOT NULL,reserved_tokens bigint NOT NULL CHECK(reserved_tokens>=0),charged_tokens bigint NOT NULL CHECK(charged_tokens>=0),
  input_tokens bigint NOT NULL DEFAULT 0 CHECK(input_tokens>=0),output_tokens bigint NOT NULL DEFAULT 0 CHECK(output_tokens>=0),
  measurement text NOT NULL DEFAULT 'upper_bound' CHECK(measurement IN ('upper_bound','reported','not_dispatched')),
  state text NOT NULL CHECK(state IN ('running','completed','failed','cancelled','timed_out')),
  failure_code text,created_at bigint NOT NULL,foreground_revision bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(tenant_id,account_id,claim_token),FOREIGN KEY(tenant_id,account_id) REFERENCES accounts(tenant_id,id),
  FOREIGN KEY(tenant_id,account_id,job_id) REFERENCES learning_jobs(tenant_id,account_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS learning_attempts_budget ON learning_attempts(tenant_id,account_id,day);
CREATE TABLE IF NOT EXISTS learning_retained_usage (
  tenant_id text NOT NULL,account_id text NOT NULL,day date NOT NULL,
  charged_tokens bigint NOT NULL,input_tokens bigint NOT NULL,output_tokens bigint NOT NULL,
  requests bigint NOT NULL,estimated_requests bigint NOT NULL,reported_requests bigint NOT NULL,
  PRIMARY KEY(tenant_id,account_id,day),FOREIGN KEY(tenant_id,account_id) REFERENCES accounts(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS learning_background_leases (
  tenant_id text NOT NULL,account_id text NOT NULL,claim_token uuid NOT NULL,purpose text NOT NULL,
  lease_until bigint NOT NULL,
  PRIMARY KEY(tenant_id,account_id),FOREIGN KEY(tenant_id,account_id) REFERENCES accounts(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS learning_foreground_activity (
  tenant_id text NOT NULL,account_id text NOT NULL,last_activity_at bigint NOT NULL,revision bigint NOT NULL DEFAULT 1,
  PRIMARY KEY(tenant_id,account_id),FOREIGN KEY(tenant_id,account_id) REFERENCES accounts(tenant_id,id)
);
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['learning_jobs','learning_job_events','learning_attempts','learning_retained_usage','learning_background_leases','learning_foreground_activity'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename=table_name AND policyname='tenant_scope') THEN
      EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id=current_setting(''app.tenant_id'',true)) WITH CHECK (tenant_id=current_setting(''app.tenant_id'',true))',table_name);
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename=table_name AND policyname='learning_account_scope') THEN
      EXECUTE format('CREATE POLICY learning_account_scope ON %I AS RESTRICTIVE TO autoreply_app USING (account_id=current_setting(''app.learning_account_id'',true)) WITH CHECK (account_id=current_setting(''app.learning_account_id'',true))',table_name);
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename=table_name AND policyname='admin_login_scope') THEN
      EXECUTE format('CREATE POLICY admin_login_scope ON %I AS RESTRICTIVE TO autoreply_admin USING(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id))) WITH CHECK(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id)))',table_name);
    END IF;
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO autoreply_app,autoreply_admin',table_name);
  END LOOP;
END $$;
