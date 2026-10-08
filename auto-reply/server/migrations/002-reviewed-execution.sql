SET search_path=autoreply,public;
CREATE TABLE IF NOT EXISTS published_configurations (
  tenant_id text NOT NULL, account_id text NOT NULL,
  config_version text NOT NULL, knowledge_version text NOT NULL,
  policy_version text NOT NULL, questions_version text NOT NULL, model_resolved text NOT NULL,
  automatic_enabled boolean NOT NULL DEFAULT false,
  PRIMARY KEY(tenant_id,account_id),
  FOREIGN KEY(tenant_id,account_id) REFERENCES accounts(tenant_id,id)
);
-- Metadata only: no customer conversation text or generated reply is retained here.
CREATE TABLE IF NOT EXISTS reviewed_replies (
  tenant_id text NOT NULL, account_id text NOT NULL, task_id text NOT NULL,
  agent_id text NOT NULL, task_hash text NOT NULL, task_json jsonb NOT NULL,
  draft_hash text NOT NULL, draft_revision bigint NOT NULL, review_json jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(tenant_id,account_id,task_id),
  FOREIGN KEY(tenant_id,agent_id,account_id) REFERENCES agents(tenant_id,id,account_id)
);
ALTER TABLE execution_permits ADD COLUMN IF NOT EXISTS task_hash text;
ALTER TABLE execution_permits ADD COLUMN IF NOT EXISTS conversation_id text;
ALTER TABLE execution_permits ADD COLUMN IF NOT EXISTS draft_revision bigint;
ALTER TABLE execution_permits ADD COLUMN IF NOT EXISTS login_epoch bigint;
ALTER TABLE execution_permits ADD COLUMN IF NOT EXISTS client_instance_id text;
ALTER TABLE execution_permits ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE execution_permits ADD COLUMN IF NOT EXISTS settlement_hash text;
-- Existing issued/unknown permits without metadata remain unresolved. Never
-- expire them into 'not_sent': expiration says nothing about physical delivery.
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['published_configurations','reviewed_replies'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename=table_name AND policyname='tenant_scope') THEN
      EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id=current_setting(''app.tenant_id'',true)) WITH CHECK (tenant_id=current_setting(''app.tenant_id'',true))',table_name);
    END IF;
  END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON published_configurations,reviewed_replies TO autoreply_app;
