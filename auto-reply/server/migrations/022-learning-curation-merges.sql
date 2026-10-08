SET search_path=autoreply,public;
ALTER TABLE learning_validation_runs ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'validation' CHECK(purpose IN ('validation','curation'));
CREATE TABLE IF NOT EXISTS learning_memory_replacements (
  tenant_id text NOT NULL,account_id text NOT NULL,conversation_id text NOT NULL DEFAULT '',
  proposed_id uuid NOT NULL,proposed_revision integer NOT NULL,superseded_id uuid NOT NULL,superseded_revision integer NOT NULL,applied_at bigint,
  PRIMARY KEY(tenant_id,account_id,proposed_id,proposed_revision,superseded_id),
  FOREIGN KEY(tenant_id,account_id,proposed_id,proposed_revision) REFERENCES learning_revisions(tenant_id,account_id,memory_id,revision) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,account_id,superseded_id,superseded_revision) REFERENCES learning_revisions(tenant_id,account_id,memory_id,revision) ON DELETE CASCADE,
  CHECK(proposed_id<>superseded_id)
);
ALTER TABLE learning_memory_replacements ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_memory_replacements FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename='learning_memory_replacements' AND policyname='replacement_scope') THEN
    CREATE POLICY replacement_scope ON learning_memory_replacements USING(tenant_id=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id=current_setting('app.tenant_id',true));
    CREATE POLICY replacement_account_scope ON learning_memory_replacements AS RESTRICTIVE TO autoreply_app USING(account_id=current_setting('app.learning_account_id',true)) WITH CHECK(account_id=current_setting('app.learning_account_id',true));
    CREATE POLICY replacement_admin_scope ON learning_memory_replacements AS RESTRICTIVE TO autoreply_admin USING(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id))) WITH CHECK(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id)));
  END IF;
END $$;
GRANT SELECT ON learning_memory_replacements TO autoreply_app,autoreply_admin;
GRANT UPDATE(applied_at) ON learning_memory_replacements TO autoreply_app;
GRANT INSERT,UPDATE,DELETE ON learning_memory_replacements TO autoreply_learning_worker;
DROP TRIGGER IF EXISTS learning_replacement_changed ON learning_memory_replacements;
CREATE TRIGGER learning_replacement_changed AFTER INSERT OR UPDATE OR DELETE ON learning_memory_replacements FOR EACH ROW EXECUTE FUNCTION autoreply.invalidate_learning_validation();
CREATE OR REPLACE FUNCTION autoreply.guard_learning_replacement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF (NEW.tenant_id,NEW.account_id,NEW.conversation_id,NEW.proposed_id,NEW.proposed_revision,NEW.superseded_id,NEW.superseded_revision)
    IS DISTINCT FROM (OLD.tenant_id,OLD.account_id,OLD.conversation_id,OLD.proposed_id,OLD.proposed_revision,OLD.superseded_id,OLD.superseded_revision)
    OR OLD.applied_at IS NOT NULL OR NEW.applied_at IS NULL THEN RAISE EXCEPTION 'learning_replacement_immutable'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION autoreply.guard_learning_replacement() FROM PUBLIC;
DROP TRIGGER IF EXISTS learning_replacement_immutable ON learning_memory_replacements;
CREATE TRIGGER learning_replacement_immutable BEFORE UPDATE ON learning_memory_replacements FOR EACH ROW EXECUTE FUNCTION autoreply.guard_learning_replacement();

-- Required references survive an old revision's cascade so a detached merge cannot activate.
CREATE TABLE IF NOT EXISTS learning_curation_candidates (
  tenant_id text NOT NULL,account_id text NOT NULL,conversation_id text NOT NULL DEFAULT '',
  proposed_id uuid NOT NULL,proposed_revision integer NOT NULL,manifest jsonb NOT NULL,
  PRIMARY KEY(tenant_id,account_id,proposed_id,proposed_revision),
  FOREIGN KEY(tenant_id,account_id,proposed_id,proposed_revision) REFERENCES learning_revisions(tenant_id,account_id,memory_id,revision) ON DELETE CASCADE,
  CHECK(jsonb_typeof(manifest)='array' AND jsonb_array_length(manifest) BETWEEN 2 AND 5)
);
ALTER TABLE learning_curation_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_curation_candidates FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename='learning_curation_candidates' AND policyname='curation_candidate_scope') THEN
    CREATE POLICY curation_candidate_scope ON learning_curation_candidates USING(tenant_id=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id=current_setting('app.tenant_id',true));
    CREATE POLICY curation_candidate_account_scope ON learning_curation_candidates AS RESTRICTIVE TO autoreply_app USING(account_id=current_setting('app.learning_account_id',true)) WITH CHECK(account_id=current_setting('app.learning_account_id',true));
    CREATE POLICY curation_candidate_admin_scope ON learning_curation_candidates AS RESTRICTIVE TO autoreply_admin USING(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id))) WITH CHECK(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id)));
  END IF;
END $$;
GRANT SELECT ON learning_curation_candidates TO autoreply_app,autoreply_admin;
GRANT INSERT,DELETE ON learning_curation_candidates TO autoreply_learning_worker;
CREATE OR REPLACE FUNCTION autoreply.guard_learning_curation_candidate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'learning_curation_candidate_immutable';
END $$;
REVOKE ALL ON FUNCTION autoreply.guard_learning_curation_candidate() FROM PUBLIC;
DROP TRIGGER IF EXISTS learning_curation_candidate_immutable ON learning_curation_candidates;
CREATE TRIGGER learning_curation_candidate_immutable BEFORE UPDATE ON learning_curation_candidates FOR EACH ROW EXECUTE FUNCTION autoreply.guard_learning_curation_candidate();
DROP TRIGGER IF EXISTS learning_curation_candidate_changed ON learning_curation_candidates;
CREATE TRIGGER learning_curation_candidate_changed AFTER INSERT OR UPDATE OR DELETE ON learning_curation_candidates FOR EACH ROW EXECUTE FUNCTION autoreply.invalidate_learning_validation();
