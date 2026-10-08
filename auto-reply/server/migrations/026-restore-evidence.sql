SET search_path=autoreply,public;
CREATE UNIQUE INDEX IF NOT EXISTS ledger_restore_inventory_case_upload ON ledger_restore_inventory_uploads(tenant_id,account_id,case_id,id);
CREATE TABLE IF NOT EXISTS ledger_restore_evidence (
 tenant_id text NOT NULL,account_id text NOT NULL,case_id uuid NOT NULL,upload_id uuid NOT NULL,note_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 basis_hash text NOT NULL CHECK(basis_hash ~ '^[a-f0-9]{64}$'),
 subject_key text NOT NULL,subject_hash text NOT NULL CHECK(subject_hash ~ '^[a-f0-9]{64}$'),
 request_json jsonb NOT NULL CHECK(jsonb_typeof(request_json)='object'),
 receipt_hash text NOT NULL CHECK(receipt_hash ~ '^[a-f0-9]{64}$'),receipt_json jsonb NOT NULL CHECK(jsonb_typeof(receipt_json)='object'),
 recorded_by text NOT NULL,recorded_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,account_id,case_id,note_id),
 FOREIGN KEY(tenant_id,account_id,case_id,upload_id) REFERENCES ledger_restore_inventory_uploads(tenant_id,account_id,case_id,id),
 FOREIGN KEY(tenant_id,recorded_by) REFERENCES employees(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS ledger_restore_evidence_upload ON ledger_restore_evidence(tenant_id,account_id,case_id,upload_id,note_id);
ALTER TABLE ledger_restore_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_restore_evidence FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename='ledger_restore_evidence' AND policyname='tenant_scope') THEN
  CREATE POLICY tenant_scope ON ledger_restore_evidence USING(tenant_id=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id=current_setting('app.tenant_id',true));
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename='ledger_restore_evidence' AND policyname='admin_login_scope') THEN
  CREATE POLICY admin_login_scope ON ledger_restore_evidence AS RESTRICTIVE TO autoreply_admin
  USING(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id)))
  WITH CHECK(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id) a WHERE a.actor_id=recorded_by));
 END IF;
END $$;
REVOKE ALL ON ledger_restore_evidence FROM PUBLIC,autoreply_app,autoreply_admin,autoreply_learning_worker;
GRANT SELECT,INSERT ON ledger_restore_evidence TO autoreply_admin;
-- External references are append-only operator metadata, never release certificates.
