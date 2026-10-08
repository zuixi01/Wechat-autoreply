SET search_path=autoreply,public;
ALTER TABLE published_configurations ADD COLUMN IF NOT EXISTS memory_corpus_version text NOT NULL DEFAULT 'empty-enterprise-memory-v1';
CREATE TABLE IF NOT EXISTS learning_context_epochs (
  tenant_id text NOT NULL,account_id text NOT NULL,conversation_id text NOT NULL DEFAULT '',version bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(tenant_id,account_id,conversation_id),FOREIGN KEY(tenant_id,account_id) REFERENCES accounts(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS learning_preparations (
  tenant_id text NOT NULL,account_id text NOT NULL,conversation_id text NOT NULL,task_id text NOT NULL,agent_id text NOT NULL,
  unbound_task_hash text NOT NULL,task_hash text NOT NULL,task_json jsonb NOT NULL,selection_json jsonb NOT NULL,
  expires_at bigint NOT NULL,
  PRIMARY KEY(tenant_id,account_id,task_id),FOREIGN KEY(tenant_id,account_id) REFERENCES accounts(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS learning_preparations_expiry ON learning_preparations(tenant_id,account_id,expires_at);
CREATE OR REPLACE FUNCTION autoreply.bump_learning_context_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_tenant text;row_account text;row_conversation text;BEGIN
  IF TG_TABLE_NAME='learning_memories' THEN
    IF TG_OP='UPDATE' THEN
      IF (NEW.state,NEW.active_revision) IS NOT DISTINCT FROM (OLD.state,OLD.active_revision) THEN RETURN NULL; END IF;
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN row_tenant:=OLD.tenant_id;row_account:=OLD.account_id;row_conversation:=OLD.conversation_id;
  ELSE row_tenant:=NEW.tenant_id;row_account:=NEW.account_id;row_conversation:=NEW.conversation_id;END IF;
  INSERT INTO autoreply.learning_context_epochs VALUES(row_tenant,row_account,row_conversation,1)
    ON CONFLICT(tenant_id,account_id,conversation_id) DO UPDATE SET version=autoreply.learning_context_epochs.version+1;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION autoreply.bump_learning_context_epoch() FROM PUBLIC;
DROP TRIGGER IF EXISTS learning_settings_context_epoch ON learning_settings;
CREATE TRIGGER learning_settings_context_epoch AFTER INSERT OR UPDATE OR DELETE ON learning_settings FOR EACH ROW EXECUTE FUNCTION autoreply.bump_learning_context_epoch();
DROP TRIGGER IF EXISTS learning_memory_context_epoch ON learning_memories;
CREATE TRIGGER learning_memory_context_epoch AFTER UPDATE OR DELETE ON learning_memories FOR EACH ROW EXECUTE FUNCTION autoreply.bump_learning_context_epoch();
CREATE OR REPLACE FUNCTION autoreply.guard_learning_preparation() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'learning_preparation_immutable'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION autoreply.guard_learning_preparation() FROM PUBLIC;
DROP TRIGGER IF EXISTS learning_preparation_immutable ON learning_preparations;
CREATE TRIGGER learning_preparation_immutable BEFORE UPDATE ON learning_preparations FOR EACH ROW EXECUTE FUNCTION autoreply.guard_learning_preparation();
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['learning_context_epochs','learning_preparations'] LOOP
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
