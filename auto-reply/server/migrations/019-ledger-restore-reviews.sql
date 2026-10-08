SET search_path=autoreply,public;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'ledger_restore_migration_owner_invalid';
  END IF;
END $$;
-- Preparation only: no release certificate or permission to replay a permit.
CREATE TABLE IF NOT EXISTS ledger_restore_reviews (
  tenant_id text NOT NULL,account_id text NOT NULL,id uuid NOT NULL,restore_id uuid NOT NULL,
  agent_id text NOT NULL,context_hash text NOT NULL CHECK(context_hash ~ '^[a-f0-9]{64}$'),
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  captured_permit_count bigint NOT NULL CHECK(captured_permit_count>=0),
  lease_snapshot jsonb CHECK(lease_snapshot IS NULL OR jsonb_typeof(lease_snapshot)='object'),
  context_json jsonb NOT NULL CHECK(jsonb_typeof(context_json)='object'),
  opened_by text NOT NULL,opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,account_id,id),UNIQUE(tenant_id,account_id,restore_id),
  FOREIGN KEY(tenant_id,agent_id,account_id) REFERENCES agents(tenant_id,id,account_id),
  FOREIGN KEY(tenant_id,opened_by) REFERENCES employees(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS ledger_restore_review_permits (
  tenant_id text NOT NULL,account_id text NOT NULL,case_id uuid NOT NULL,permit_id text NOT NULL,
  status_at_opening text NOT NULL CHECK(status_at_opening IN ('issued','confirmed','not_sent','unknown')),
  snapshot_json jsonb NOT NULL CHECK(jsonb_typeof(snapshot_json)='object'),
  PRIMARY KEY(tenant_id,account_id,case_id,permit_id),
  FOREIGN KEY(tenant_id,account_id,case_id) REFERENCES ledger_restore_reviews(tenant_id,account_id,id),
  FOREIGN KEY(tenant_id,account_id,permit_id) REFERENCES execution_permits(tenant_id,account_id,id)
);
ALTER TABLE ledger_restore_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_restore_reviews FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_restore_review_permits ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_restore_review_permits FORCE ROW LEVEL SECURITY;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['ledger_restore_reviews','ledger_restore_review_permits'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename=t AND policyname='tenant_scope') THEN
      EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=current_setting(''app.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''app.tenant_id'',true))',t);
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename=t AND policyname='admin_login_scope') THEN
      IF t='ledger_restore_reviews' THEN
        EXECUTE format('CREATE POLICY admin_login_scope ON %I AS RESTRICTIVE TO autoreply_admin USING(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id))) WITH CHECK(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id) a WHERE a.actor_id=opened_by))',t);
      ELSE
        EXECUTE format('CREATE POLICY admin_login_scope ON %I AS RESTRICTIVE TO autoreply_admin USING(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id))) WITH CHECK(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id)))',t);
      END IF;
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON ledger_restore_reviews,ledger_restore_review_permits FROM PUBLIC,autoreply_app,autoreply_learning_worker;
GRANT SELECT,INSERT ON ledger_restore_reviews,ledger_restore_review_permits TO autoreply_admin;
-- The trusted migration owner must have BYPASSRLS, as for credential functions.
-- Both triggers inspect the exact row account, irrespective of caller tenant GUC.
CREATE OR REPLACE FUNCTION autoreply.guard_ledger_restore_pause() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,autoreply AS $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'ledger_restore_guard_owner_invalid';
  END IF;
  IF NOT NEW.paused AND EXISTS(SELECT 1 FROM ledger_restore_reviews r WHERE r.tenant_id=NEW.tenant_id AND r.account_id=NEW.id) THEN
    RAISE EXCEPTION 'ledger_restore_review_pending';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION autoreply.guard_ledger_restore_pause() FROM PUBLIC;
DROP TRIGGER IF EXISTS ledger_restore_pause_guard ON accounts;
CREATE TRIGGER ledger_restore_pause_guard BEFORE INSERT OR UPDATE OF paused ON accounts
  FOR EACH ROW EXECUTE FUNCTION autoreply.guard_ledger_restore_pause();
CREATE OR REPLACE FUNCTION autoreply.require_ledger_restore_pause() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,autoreply AS $$ DECLARE stopped boolean; BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'ledger_restore_guard_owner_invalid';
  END IF;
  SELECT paused INTO stopped FROM accounts WHERE tenant_id=NEW.tenant_id AND id=NEW.account_id FOR UPDATE;
  IF stopped IS DISTINCT FROM true THEN RAISE EXCEPTION 'ledger_restore_review_requires_pause'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION autoreply.require_ledger_restore_pause() FROM PUBLIC;
DROP TRIGGER IF EXISTS ledger_restore_requires_pause ON ledger_restore_reviews;
CREATE TRIGGER ledger_restore_requires_pause BEFORE INSERT ON ledger_restore_reviews
  FOR EACH ROW EXECUTE FUNCTION autoreply.require_ledger_restore_pause();
