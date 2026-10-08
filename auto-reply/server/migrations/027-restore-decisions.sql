SET search_path=autoreply,public;
CREATE TABLE IF NOT EXISTS ledger_restore_rulings (
 tenant_id text NOT NULL, account_id text NOT NULL, case_id uuid NOT NULL, upload_id uuid NOT NULL, ruling_id uuid NOT NULL,
 basis_hash text NOT NULL CHECK(basis_hash ~ '^[a-f0-9]{64}$'), subject_key text NOT NULL,
 revision bigint NOT NULL CHECK(revision>0), previous_ruling_id uuid, note_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'), request_json jsonb NOT NULL CHECK(jsonb_typeof(request_json)='object'),
 receipt_hash text NOT NULL CHECK(receipt_hash ~ '^[a-f0-9]{64}$'), receipt_json jsonb NOT NULL CHECK(jsonb_typeof(receipt_json)='object'),
 recorded_by text NOT NULL, recorded_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,account_id,case_id,ruling_id),
 UNIQUE(tenant_id,account_id,case_id,upload_id,basis_hash,subject_key,revision),
 FOREIGN KEY(tenant_id,account_id,case_id,upload_id) REFERENCES ledger_restore_inventory_uploads(tenant_id,account_id,case_id,id),
 FOREIGN KEY(tenant_id,account_id,case_id,previous_ruling_id) REFERENCES ledger_restore_rulings(tenant_id,account_id,case_id,ruling_id),
 FOREIGN KEY(tenant_id,account_id,case_id,note_id) REFERENCES ledger_restore_evidence(tenant_id,account_id,case_id,note_id),
 FOREIGN KEY(tenant_id,recorded_by) REFERENCES employees(tenant_id,id),
 CHECK((revision=1 AND previous_ruling_id IS NULL) OR (revision>1 AND previous_ruling_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS ledger_restore_decisions (
 tenant_id text NOT NULL, account_id text NOT NULL, case_id uuid NOT NULL, upload_id uuid NOT NULL, decision_id uuid NOT NULL,
 basis_hash text NOT NULL CHECK(basis_hash ~ '^[a-f0-9]{64}$'), rulings_hash text NOT NULL CHECK(rulings_hash ~ '^[a-f0-9]{64}$'),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'), request_json jsonb NOT NULL CHECK(jsonb_typeof(request_json)='object'),
 receipt_hash text NOT NULL CHECK(receipt_hash ~ '^[a-f0-9]{64}$'), receipt_json jsonb NOT NULL CHECK(jsonb_typeof(receipt_json)='object'),
 recorded_by text NOT NULL, recorded_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,account_id,case_id,decision_id),
 UNIQUE(tenant_id,account_id,case_id,upload_id,basis_hash),
 FOREIGN KEY(tenant_id,account_id,case_id,upload_id) REFERENCES ledger_restore_inventory_uploads(tenant_id,account_id,case_id,id),
 FOREIGN KEY(tenant_id,recorded_by) REFERENCES employees(tenant_id,id)
);
ALTER TABLE ledger_restore_rulings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_restore_rulings FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_restore_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_restore_decisions FORCE ROW LEVEL SECURITY;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['ledger_restore_rulings','ledger_restore_decisions'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename=t AND policyname='tenant_scope') THEN
   EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=current_setting(''app.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''app.tenant_id'',true))',t);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename=t AND policyname='admin_login_scope') THEN
   EXECUTE format('CREATE POLICY admin_login_scope ON %I AS RESTRICTIVE TO autoreply_admin USING(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id))) WITH CHECK(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id) a WHERE a.actor_id=recorded_by))',t);
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON ledger_restore_rulings,ledger_restore_decisions FROM PUBLIC,autoreply_app,autoreply_admin,autoreply_learning_worker;
GRANT SELECT,INSERT ON ledger_restore_rulings,ledger_restore_decisions TO autoreply_admin;
-- These decisions freeze manual review; existing central and local pause guards remain intact.
