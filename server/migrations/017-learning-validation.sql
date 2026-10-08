SET search_path=autoreply,public;
CREATE TABLE IF NOT EXISTS learning_calibration_sets (
  tenant_id text NOT NULL,account_id text NOT NULL,conversation_id text NOT NULL DEFAULT '',
  payload jsonb NOT NULL,input_hash text NOT NULL,imported_at bigint NOT NULL,
  PRIMARY KEY(tenant_id,account_id,conversation_id),
  FOREIGN KEY(tenant_id,account_id) REFERENCES accounts(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS learning_validation_environments (
  tenant_id text NOT NULL,account_id text NOT NULL,conversation_id text NOT NULL DEFAULT '',
  payload jsonb NOT NULL,epoch bigint NOT NULL DEFAULT 1 CHECK(epoch>0),
  PRIMARY KEY(tenant_id,account_id,conversation_id),
  FOREIGN KEY(tenant_id,account_id) REFERENCES accounts(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS learning_activation_grants (
  tenant_id text NOT NULL,account_id text NOT NULL,conversation_id text NOT NULL DEFAULT '',
  id uuid NOT NULL,memory_id uuid NOT NULL,revision integer NOT NULL,payload jsonb NOT NULL,
  used_at bigint,
  PRIMARY KEY(tenant_id,account_id,id),
  FOREIGN KEY(tenant_id,account_id,memory_id,revision) REFERENCES learning_revisions(tenant_id,account_id,memory_id,revision) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS learning_validation_reports (
  tenant_id text NOT NULL,account_id text NOT NULL,conversation_id text NOT NULL DEFAULT '',
  id uuid NOT NULL,memory_id uuid NOT NULL,revision integer NOT NULL,payload jsonb NOT NULL,
  PRIMARY KEY(tenant_id,account_id,id),
  FOREIGN KEY(tenant_id,account_id,memory_id,revision) REFERENCES learning_revisions(tenant_id,account_id,memory_id,revision) ON DELETE CASCADE
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['learning_calibration_sets','learning_validation_environments','learning_activation_grants','learning_validation_reports'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename=t AND policyname='validation_scope') THEN
      EXECUTE format('CREATE POLICY validation_scope ON %I USING(tenant_id=current_setting(''app.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''app.tenant_id'',true))',t);
      EXECUTE format('CREATE POLICY validation_account_scope ON %I AS RESTRICTIVE TO autoreply_app USING(account_id=current_setting(''app.learning_account_id'',true)) WITH CHECK(account_id=current_setting(''app.learning_account_id'',true))',t);
      EXECUTE format('CREATE POLICY validation_admin_scope ON %I AS RESTRICTIVE TO autoreply_admin USING(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id))) WITH CHECK(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id)))',t);
    END IF;
    EXECUTE format('GRANT SELECT ON %I TO autoreply_app,autoreply_admin',t);
    EXECUTE format('GRANT INSERT,UPDATE,DELETE ON %I TO autoreply_learning_worker',t);
  END LOOP;
END $$;
GRANT INSERT,UPDATE,DELETE ON learning_calibration_sets TO autoreply_app;

-- Trigger execution sees mutations even if an environment changes and reverts between reads.
-- Existing grant holders have a row already; new environments need no historical epoch.
CREATE OR REPLACE FUNCTION autoreply.invalidate_learning_validation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,autoreply,pg_temp AS $$
DECLARE row_tenant text;row_account text;before_payload jsonb;after_payload jsonb;
BEGIN
  IF TG_OP='DELETE' THEN row_tenant:=OLD.tenant_id;row_account:=OLD.account_id;
  ELSE row_tenant:=NEW.tenant_id;row_account:=NEW.account_id; END IF;
  IF TG_TABLE_NAME='learning_settings' THEN
    before_payload:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE OLD.payload END;
    after_payload:=CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE NEW.payload END;
    IF (before_payload-'mode') IS NOT DISTINCT FROM (after_payload-'mode')
      AND COALESCE(before_payload->>'mode','suggest')<>'off'
      AND COALESCE(after_payload->>'mode','suggest')<>'off' THEN RETURN NULL; END IF;
  END IF;
  UPDATE autoreply.learning_validation_environments SET epoch=epoch+1
    WHERE tenant_id=row_tenant AND account_id=row_account;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION autoreply.invalidate_learning_validation() FROM PUBLIC;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['published_configurations','learning_calibration_sets','learning_settings','learning_episodes','learning_memories','learning_revisions','learning_quarantines','learning_tombstones'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS learning_validation_changed ON %I',t);
    EXECUTE format('CREATE TRIGGER learning_validation_changed AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION autoreply.invalidate_learning_validation()',t);
  END LOOP;
END $$;
CREATE OR REPLACE FUNCTION autoreply.guard_learning_grant() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF (NEW.tenant_id,NEW.account_id,NEW.conversation_id,NEW.id,NEW.memory_id,NEW.revision,NEW.payload)
    IS DISTINCT FROM (OLD.tenant_id,OLD.account_id,OLD.conversation_id,OLD.id,OLD.memory_id,OLD.revision,OLD.payload)
    OR OLD.used_at IS NOT NULL OR NEW.used_at IS NULL THEN RAISE EXCEPTION 'validation_grant_immutable'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION autoreply.guard_learning_grant() FROM PUBLIC;
DROP TRIGGER IF EXISTS learning_grant_immutable ON learning_activation_grants;
CREATE TRIGGER learning_grant_immutable BEFORE UPDATE ON learning_activation_grants FOR EACH ROW EXECUTE FUNCTION autoreply.guard_learning_grant();
