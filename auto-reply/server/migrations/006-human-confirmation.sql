SET search_path=autoreply,public;
CREATE TABLE IF NOT EXISTS human_confirmations (
  tenant_id text NOT NULL,account_id text NOT NULL,id text NOT NULL,
  agent_id text NOT NULL,task_id text NOT NULL,source_task_id text NOT NULL,
  task_hash text NOT NULL,draft_hash text NOT NULL,draft_revision bigint NOT NULL,
  confirmation_json jsonb NOT NULL,task_json jsonb NOT NULL,request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
  PRIMARY KEY(tenant_id,account_id,id),UNIQUE(tenant_id,account_id,task_id),
  FOREIGN KEY(tenant_id,agent_id,account_id) REFERENCES agents(tenant_id,id,account_id)
);
ALTER TABLE human_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE human_confirmations FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename='human_confirmations' AND policyname='tenant_scope') THEN
    CREATE POLICY tenant_scope ON human_confirmations
      USING(tenant_id=current_setting('app.tenant_id',true))
      WITH CHECK(tenant_id=current_setting('app.tenant_id',true));
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename='human_confirmations' AND policyname='admin_login_scope') THEN
    CREATE POLICY admin_login_scope ON human_confirmations AS RESTRICTIVE TO autoreply_admin
      USING(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id)))
      WITH CHECK(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id)));
  END IF;
END $$;
GRANT SELECT,INSERT ON human_confirmations TO autoreply_app;
GRANT SELECT ON human_confirmations TO autoreply_admin;
ALTER TABLE execution_permits ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'automatic';
ALTER TABLE execution_permits ADD COLUMN IF NOT EXISTS confirmation_id text;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='autoreply.execution_permits'::regclass AND conname='execution_purpose') THEN
    ALTER TABLE execution_permits ADD CONSTRAINT execution_purpose CHECK
      ((purpose='automatic' AND confirmation_id IS NULL) OR (purpose='human' AND confirmation_id IS NOT NULL));
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='autoreply.execution_permits'::regclass AND conname='execution_human_confirmation') THEN
    ALTER TABLE execution_permits ADD CONSTRAINT execution_human_confirmation
      FOREIGN KEY(tenant_id,account_id,confirmation_id) REFERENCES human_confirmations(tenant_id,account_id,id);
  END IF;
END $$;
