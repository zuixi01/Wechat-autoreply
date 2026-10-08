SET search_path=autoreply,public;
CREATE TABLE IF NOT EXISTS learning_episode_closures (
  tenant_id text NOT NULL,account_id text NOT NULL,conversation_id text NOT NULL,
  source_episode_id uuid NOT NULL,episode_id uuid NOT NULL,
  last_activity_at bigint NOT NULL,closed_at bigint NOT NULL,
  reason text NOT NULL CHECK(reason='idle_unknown'),
  PRIMARY KEY(tenant_id,account_id,source_episode_id),
  UNIQUE(tenant_id,account_id,episode_id),
  CHECK(source_episode_id<>episode_id),
  CHECK(closed_at>=last_activity_at+1800000),
  FOREIGN KEY(tenant_id,account_id,source_episode_id) REFERENCES learning_episodes(tenant_id,account_id,id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,account_id,episode_id) REFERENCES learning_episodes(tenant_id,account_id,id) ON DELETE CASCADE
);
ALTER TABLE learning_episode_closures ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_episode_closures FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename='learning_episode_closures' AND policyname='tenant_scope') THEN
    CREATE POLICY tenant_scope ON learning_episode_closures USING(tenant_id=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id=current_setting('app.tenant_id',true));
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename='learning_episode_closures' AND policyname='learning_account_scope') THEN
    CREATE POLICY learning_account_scope ON learning_episode_closures AS RESTRICTIVE TO autoreply_app USING(account_id=current_setting('app.learning_account_id',true)) WITH CHECK(account_id=current_setting('app.learning_account_id',true));
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename='learning_episode_closures' AND policyname='admin_login_scope') THEN
    CREATE POLICY admin_login_scope ON learning_episode_closures AS RESTRICTIVE TO autoreply_admin USING(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id))) WITH CHECK(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id)));
  END IF;
END $$;
GRANT SELECT,DELETE ON learning_episode_closures TO autoreply_app;
GRANT SELECT ON learning_episode_closures TO autoreply_admin;
GRANT INSERT,DELETE ON learning_episode_closures TO autoreply_learning_worker;
