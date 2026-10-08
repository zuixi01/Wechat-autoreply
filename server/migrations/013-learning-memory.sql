SET search_path=autoreply,public;
ALTER TABLE generation_publications ADD COLUMN IF NOT EXISTS memory_corpus_version text NOT NULL DEFAULT 'empty-enterprise-memory-v1';
ALTER TABLE generation_publications ADD COLUMN IF NOT EXISTS memory_manifest_json jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE TABLE IF NOT EXISTS learning_versions (
  tenant_id text NOT NULL,account_id text NOT NULL,conversation_id text NOT NULL DEFAULT '',version bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(tenant_id,account_id,conversation_id),FOREIGN KEY(tenant_id,account_id) REFERENCES accounts(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS learning_episodes (
  tenant_id text NOT NULL,account_id text NOT NULL,conversation_id text NOT NULL DEFAULT '',id uuid NOT NULL,
  source_id text NOT NULL,input_hash text NOT NULL,payload jsonb NOT NULL,created_at bigint NOT NULL,
  PRIMARY KEY(tenant_id,account_id,id),UNIQUE(tenant_id,account_id,conversation_id,source_id),
  FOREIGN KEY(tenant_id,account_id) REFERENCES accounts(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS learning_episode_retention ON learning_episodes(tenant_id,account_id,conversation_id,created_at);
CREATE TABLE IF NOT EXISTS learning_memories (
  tenant_id text NOT NULL,account_id text NOT NULL,conversation_id text NOT NULL DEFAULT '',id uuid NOT NULL,
  state text NOT NULL CHECK(state IN ('pending','active','stale','archived')),
  current_revision integer NOT NULL CHECK(current_revision>0),active_revision integer CHECK(active_revision>0 AND active_revision<=current_revision),
  pinned boolean NOT NULL DEFAULT false,created_at bigint NOT NULL,updated_at bigint NOT NULL,
  PRIMARY KEY(tenant_id,account_id,id),FOREIGN KEY(tenant_id,account_id) REFERENCES accounts(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS learning_revisions (
  tenant_id text NOT NULL,account_id text NOT NULL,conversation_id text NOT NULL DEFAULT '',memory_id uuid NOT NULL,
  revision integer NOT NULL CHECK(revision>0),content_hash text NOT NULL,payload jsonb NOT NULL,activated_at bigint,
  PRIMARY KEY(tenant_id,account_id,memory_id,revision),FOREIGN KEY(tenant_id,account_id,memory_id) REFERENCES learning_memories(tenant_id,account_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS learning_settings (
  tenant_id text NOT NULL,account_id text NOT NULL,conversation_id text NOT NULL DEFAULT '',payload jsonb NOT NULL,
  PRIMARY KEY(tenant_id,account_id,conversation_id),FOREIGN KEY(tenant_id,account_id) REFERENCES accounts(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS learning_generations (
  tenant_id text NOT NULL,account_id text NOT NULL,conversation_id text NOT NULL DEFAULT '',generation_id text NOT NULL,
  episode_id uuid NOT NULL,refs_json jsonb NOT NULL,input_hash text NOT NULL,
  PRIMARY KEY(tenant_id,account_id,conversation_id,generation_id),FOREIGN KEY(tenant_id,account_id,episode_id) REFERENCES learning_episodes(tenant_id,account_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS learning_feedback (
  tenant_id text NOT NULL,account_id text NOT NULL,conversation_id text NOT NULL DEFAULT '',source_id text NOT NULL,
  input_hash text NOT NULL,episode_id uuid NOT NULL,payload jsonb NOT NULL,
  PRIMARY KEY(tenant_id,account_id,conversation_id,source_id),FOREIGN KEY(tenant_id,account_id,episode_id) REFERENCES learning_episodes(tenant_id,account_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS learning_quarantines (
  tenant_id text NOT NULL,account_id text NOT NULL,conversation_id text NOT NULL DEFAULT '',memory_id uuid NOT NULL,
  revision integer NOT NULL,source_id text NOT NULL,at bigint NOT NULL,
  PRIMARY KEY(tenant_id,account_id,memory_id,revision),FOREIGN KEY(tenant_id,account_id,memory_id,revision) REFERENCES learning_revisions(tenant_id,account_id,memory_id,revision) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS learning_tombstones (
  tenant_id text NOT NULL,account_id text NOT NULL,conversation_id text NOT NULL DEFAULT '',kind text NOT NULL,fingerprint text NOT NULL,at bigint NOT NULL,
  PRIMARY KEY(tenant_id,account_id,conversation_id,kind,fingerprint),FOREIGN KEY(tenant_id,account_id) REFERENCES accounts(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS learning_mutations (
  tenant_id text NOT NULL,account_id text NOT NULL,conversation_id text NOT NULL DEFAULT '',id uuid NOT NULL,
  memory_id uuid NOT NULL,action text NOT NULL,revision integer NOT NULL,employee_id text NOT NULL,at bigint NOT NULL,
  PRIMARY KEY(tenant_id,account_id,id),FOREIGN KEY(tenant_id,account_id) REFERENCES accounts(tenant_id,id)
);
CREATE OR REPLACE FUNCTION autoreply.bump_learning_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_tenant text; row_account text; row_conversation text; BEGIN
  IF TG_OP='DELETE' THEN row_tenant:=OLD.tenant_id;row_account:=OLD.account_id;row_conversation:=OLD.conversation_id;
  ELSE row_tenant:=NEW.tenant_id;row_account:=NEW.account_id;row_conversation:=NEW.conversation_id; END IF;
  INSERT INTO autoreply.learning_versions(tenant_id,account_id,conversation_id,version) VALUES(row_tenant,row_account,row_conversation,1)
    ON CONFLICT(tenant_id,account_id,conversation_id) DO UPDATE SET version=autoreply.learning_versions.version+1;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION autoreply.bump_learning_version() FROM PUBLIC;
CREATE OR REPLACE FUNCTION autoreply.guard_learning_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF (NEW.tenant_id,NEW.account_id,NEW.conversation_id,NEW.memory_id,NEW.revision,NEW.content_hash,NEW.payload)
    IS DISTINCT FROM (OLD.tenant_id,OLD.account_id,OLD.conversation_id,OLD.memory_id,OLD.revision,OLD.content_hash,OLD.payload)
    OR (OLD.activated_at IS NOT NULL AND NEW.activated_at IS DISTINCT FROM OLD.activated_at)
    THEN RAISE EXCEPTION 'learning_revision_immutable'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION autoreply.guard_learning_revision() FROM PUBLIC;
DROP TRIGGER IF EXISTS learning_revision_immutable ON learning_revisions;
CREATE TRIGGER learning_revision_immutable BEFORE UPDATE ON learning_revisions FOR EACH ROW EXECUTE FUNCTION autoreply.guard_learning_revision();
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['learning_versions','learning_episodes','learning_memories','learning_revisions','learning_settings','learning_generations','learning_feedback','learning_quarantines','learning_tombstones','learning_mutations'] LOOP
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
    IF table_name<>'learning_versions' THEN
      EXECUTE format('DROP TRIGGER IF EXISTS learning_version_change ON %I',table_name);
      EXECUTE format('CREATE TRIGGER learning_version_change AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION autoreply.bump_learning_version()',table_name);
    END IF;
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO autoreply_app,autoreply_admin',table_name);
  END LOOP;
END $$;
