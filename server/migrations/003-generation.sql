SET search_path=autoreply,public;
CREATE TABLE IF NOT EXISTS generation_publications (
  tenant_id text NOT NULL,account_id text NOT NULL,config_version text NOT NULL,
  publication_hash text NOT NULL,config_json jsonb NOT NULL,policy_json jsonb NOT NULL,
  evidence_json jsonb NOT NULL,text_generator_version text NOT NULL,question_set_hash text,
  PRIMARY KEY(tenant_id,account_id,config_version),
  FOREIGN KEY(tenant_id,account_id) REFERENCES accounts(tenant_id,id)
);
ALTER TABLE generation_publications ADD COLUMN IF NOT EXISTS question_set_hash text;
CREATE TABLE IF NOT EXISTS generation_tasks (
  tenant_id text NOT NULL,account_id text NOT NULL,task_id text NOT NULL,
  agent_id text NOT NULL,request_hash text NOT NULL,task_json jsonb NOT NULL,
  status text NOT NULL CHECK(status IN ('running','completed','failed')),
  result_json jsonb,started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,account_id,task_id),
  FOREIGN KEY(tenant_id,agent_id,account_id) REFERENCES agents(tenant_id,id,account_id),
  CHECK((status='completed')=(result_json IS NOT NULL))
);
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['generation_publications','generation_tasks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename=table_name AND policyname='tenant_scope') THEN
      EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id=current_setting(''app.tenant_id'',true)) WITH CHECK (tenant_id=current_setting(''app.tenant_id'',true))',table_name);
    END IF;
  END LOOP;
END $$;
-- Publication versions are append-only to the ordinary service role.
GRANT SELECT,INSERT ON generation_publications TO autoreply_app;
GRANT SELECT,INSERT,UPDATE ON generation_tasks TO autoreply_app;
