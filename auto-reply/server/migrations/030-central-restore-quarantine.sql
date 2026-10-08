SET search_path=autoreply,public;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'central_restore_migration_owner_invalid';
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS database_restore_quarantines (
  sequence integer PRIMARY KEY CHECK(sequence>0), restore_id uuid NOT NULL UNIQUE,
  backup_id uuid NOT NULL, archive_sha256 text NOT NULL CHECK(archive_sha256 ~ '^[a-f0-9]{64}$'),
  archive_bytes bigint NOT NULL CHECK(archive_bytes>0), database_name text NOT NULL,
  previous_restore_id uuid, previous_context_hash text,
  context_hash text NOT NULL CHECK(context_hash ~ '^[a-f0-9]{64}$'), receipt_json jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  CHECK(jsonb_typeof(receipt_json)='object'),
  CHECK((previous_restore_id IS NULL)=(previous_context_hash IS NULL))
);
ALTER TABLE database_restore_quarantines ENABLE ROW LEVEL SECURITY;
ALTER TABLE database_restore_quarantines FORCE ROW LEVEL SECURITY;
REVOKE ALL ON database_restore_quarantines FROM PUBLIC,autoreply_app,autoreply_admin,autoreply_learning_worker,autoreply_restore_reader;
CREATE OR REPLACE FUNCTION autoreply.central_restore_history_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,autoreply AS $$ BEGIN
  RAISE EXCEPTION 'central_restore_history_immutable';
END $$;
REVOKE ALL ON FUNCTION autoreply.central_restore_history_immutable() FROM PUBLIC;
DROP TRIGGER IF EXISTS central_restore_history_immutable ON database_restore_quarantines;
CREATE TRIGGER central_restore_history_immutable BEFORE UPDATE OR DELETE ON database_restore_quarantines
FOR EACH ROW EXECUTE FUNCTION autoreply.central_restore_history_immutable();

-- Global database recovery differs from a per-account local ledger restoration.
-- There is intentionally no administrator release bit or mutable sidecar here.
CREATE OR REPLACE FUNCTION autoreply.guard_central_restore() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,autoreply AS $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'central_restore_guard_owner_invalid';
  END IF;
  IF EXISTS(SELECT 1 FROM database_restore_quarantines) THEN
    CASE TG_TABLE_NAME
      WHEN 'accounts' THEN
        IF NOT NEW.paused THEN RAISE EXCEPTION 'central_restore_review_pending'; END IF;
      WHEN 'account_leases' THEN
        IF NEW.expires_at>clock_timestamp() THEN RAISE EXCEPTION 'central_restore_review_pending'; END IF;
      WHEN 'execution_permits' THEN
        IF NEW.status='issued' THEN RAISE EXCEPTION 'central_restore_review_pending'; END IF;
      WHEN 'agents' THEN
        IF NEW.revoked_at IS NULL THEN RAISE EXCEPTION 'central_restore_review_pending'; END IF;
      WHEN 'enrollment_codes' THEN
        IF NEW.used_at IS NULL AND NEW.expires_at>clock_timestamp() THEN RAISE EXCEPTION 'central_restore_review_pending'; END IF;
      WHEN 'learning_background_leases' THEN
        IF NEW.lease_until>floor(extract(epoch FROM clock_timestamp())*1000) THEN RAISE EXCEPTION 'central_restore_review_pending'; END IF;
    END CASE;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION autoreply.guard_central_restore() FROM PUBLIC;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['accounts','account_leases','execution_permits','agents','enrollment_codes','learning_background_leases'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS central_restore_guard ON autoreply.%I',t);
    EXECUTE format('CREATE TRIGGER central_restore_guard BEFORE INSERT OR UPDATE ON autoreply.%I FOR EACH ROW EXECUTE FUNCTION autoreply.guard_central_restore()',t);
  END LOOP;
END $$;
