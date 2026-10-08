SET search_path=autoreply,public;
-- Independent maintenance evidence is never supplied by a device or ordinary administrator.
CREATE TABLE IF NOT EXISTS ledger_restore_history_requirements (
 tenant_id text NOT NULL,account_id text NOT NULL,case_id uuid NOT NULL,upload_id uuid NOT NULL,id uuid NOT NULL,
 requirement_hash text NOT NULL CHECK(requirement_hash ~ '^[a-f0-9]{64}$'),
 requirement_json jsonb NOT NULL CHECK(jsonb_typeof(requirement_json)='object' AND octet_length(requirement_json::text)<=16384),
 recorded_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,account_id,case_id,id),
 UNIQUE(tenant_id,account_id,case_id,upload_id,id),
 FOREIGN KEY(tenant_id,account_id,case_id,upload_id) REFERENCES ledger_restore_inventory_uploads(tenant_id,account_id,case_id,id)
);
CREATE TABLE IF NOT EXISTS restore_history_key_revocations (
 key_sha256 text PRIMARY KEY CHECK(key_sha256 ~ '^[a-f0-9]{64}$'),
 reason_sha256 text NOT NULL CHECK(reason_sha256 ~ '^[a-f0-9]{64}$'),recorded_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger_restore_history_proofs (
 tenant_id text NOT NULL,account_id text NOT NULL,case_id uuid NOT NULL,upload_id uuid NOT NULL,proof_id uuid NOT NULL,requirement_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 request_json jsonb NOT NULL CHECK(jsonb_typeof(request_json)='object' AND octet_length(request_json::text)<=1048576),
 receipt_hash text NOT NULL CHECK(receipt_hash ~ '^[a-f0-9]{64}$'),
 receipt_json jsonb NOT NULL CHECK(jsonb_typeof(receipt_json)='object' AND octet_length(receipt_json::text)<=16384),
 recorded_by text NOT NULL,recorded_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,account_id,proof_id),
 FOREIGN KEY(tenant_id,account_id,case_id,upload_id,requirement_id) REFERENCES ledger_restore_history_requirements(tenant_id,account_id,case_id,upload_id,id),
 FOREIGN KEY(tenant_id,recorded_by) REFERENCES employees(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS ledger_restore_history_proofs_case ON ledger_restore_history_proofs(tenant_id,account_id,case_id,proof_id);
CREATE OR REPLACE FUNCTION autoreply.restore_history_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,autoreply AS $$ BEGIN
 RAISE EXCEPTION 'restore_history_immutable';
END $$;
REVOKE ALL ON FUNCTION autoreply.restore_history_immutable() FROM PUBLIC;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['ledger_restore_history_requirements','restore_history_key_revocations','ledger_restore_history_proofs'] LOOP
  EXECUTE format('ALTER TABLE autoreply.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE autoreply.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('DROP TRIGGER IF EXISTS restore_history_immutable ON autoreply.%I',t);
  EXECUTE format('CREATE TRIGGER restore_history_immutable BEFORE UPDATE OR DELETE ON autoreply.%I FOR EACH ROW EXECUTE FUNCTION autoreply.restore_history_immutable()',t);
  EXECUTE format('REVOKE ALL ON autoreply.%I FROM PUBLIC,autoreply_app,autoreply_admin,autoreply_learning_worker,autoreply_restore_reader',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['ledger_restore_history_requirements','ledger_restore_history_proofs'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename=t AND policyname='tenant_scope') THEN
   EXECUTE format('CREATE POLICY tenant_scope ON autoreply.%I USING(tenant_id=current_setting(''app.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''app.tenant_id'',true))',t);
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename='ledger_restore_history_requirements' AND policyname='admin_login_scope') THEN
  CREATE POLICY admin_login_scope ON ledger_restore_history_requirements AS RESTRICTIVE TO autoreply_admin
  USING(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id))) WITH CHECK(false);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename='ledger_restore_history_proofs' AND policyname='admin_login_scope') THEN
  CREATE POLICY admin_login_scope ON ledger_restore_history_proofs AS RESTRICTIVE TO autoreply_admin
  USING(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id)))
  WITH CHECK(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id) a WHERE a.actor_id=recorded_by));
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename='restore_history_key_revocations' AND policyname='admin_login_scope') THEN
  CREATE POLICY admin_login_scope ON restore_history_key_revocations TO autoreply_admin
  USING(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(current_setting('app.tenant_id',true)))) WITH CHECK(false);
 END IF;
END $$;
GRANT SELECT ON ledger_restore_history_requirements,restore_history_key_revocations TO autoreply_admin;
GRANT SELECT,INSERT ON ledger_restore_history_proofs TO autoreply_admin;
-- All receipts remain non-authorizing. Existing restoration/send/lease guards are untouched.
