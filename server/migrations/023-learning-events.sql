SET search_path=autoreply,public;
CREATE TABLE IF NOT EXISTS learning_task_events (
  tenant_id text NOT NULL, account_id text NOT NULL, conversation_id text NOT NULL,
  source_id text NOT NULL, input_hash text NOT NULL, kind text NOT NULL CHECK(kind IN ('correction','result','feedback')),
  source_episode_id uuid NOT NULL, episode_id uuid NOT NULL, employee_id text NOT NULL, at bigint NOT NULL,
  event_sequence bigint GENERATED ALWAYS AS IDENTITY,
  PRIMARY KEY(tenant_id,account_id,source_id),
  FOREIGN KEY(tenant_id,account_id,source_episode_id) REFERENCES learning_episodes(tenant_id,account_id,id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,account_id,episode_id) REFERENCES learning_episodes(tenant_id,account_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS learning_task_event_source ON learning_task_events(tenant_id,account_id,source_episode_id,at);
ALTER TABLE learning_task_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_task_events FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename='learning_task_events' AND policyname='tenant_scope') THEN
    CREATE POLICY tenant_scope ON learning_task_events USING(tenant_id=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id=current_setting('app.tenant_id',true));
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename='learning_task_events' AND policyname='learning_account_scope') THEN
    CREATE POLICY learning_account_scope ON learning_task_events AS RESTRICTIVE TO autoreply_app USING(account_id=current_setting('app.learning_account_id',true)) WITH CHECK(account_id=current_setting('app.learning_account_id',true));
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename='learning_task_events' AND policyname='admin_login_scope') THEN
    CREATE POLICY admin_login_scope ON learning_task_events AS RESTRICTIVE TO autoreply_admin USING(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id))) WITH CHECK(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id)));
  END IF;
END $$;
GRANT SELECT,INSERT,DELETE ON learning_task_events TO autoreply_app,autoreply_admin;
