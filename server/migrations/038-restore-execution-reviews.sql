SET search_path=autoreply,public;
-- Independent maintenance reviews do not settle permits or release restoration guards.
CREATE TABLE IF NOT EXISTS ledger_restore_execution_reviews (
 tenant_id text NOT NULL,account_id text NOT NULL,case_id uuid NOT NULL,upload_id uuid NOT NULL,
 review_id uuid NOT NULL,history_proof_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 request_json jsonb NOT NULL CHECK(jsonb_typeof(request_json)='object' AND octet_length(request_json::text)<=1048576),
 subjects_hash text NOT NULL CHECK(subjects_hash ~ '^[a-f0-9]{64}$'),
 subjects_json jsonb NOT NULL CHECK(jsonb_typeof(subjects_json)='array' AND octet_length(subjects_json::text)<=1048576),
 receipt_hash text NOT NULL CHECK(receipt_hash ~ '^[a-f0-9]{64}$'),
 receipt_json jsonb NOT NULL CHECK(jsonb_typeof(receipt_json)='object' AND octet_length(receipt_json::text)<=16384),
 recorded_by text NOT NULL,recorded_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,account_id,review_id),
 FOREIGN KEY(tenant_id,account_id,history_proof_id) REFERENCES ledger_restore_history_proofs(tenant_id,account_id,proof_id),
 FOREIGN KEY(tenant_id,account_id,case_id,upload_id) REFERENCES ledger_restore_inventory_uploads(tenant_id,account_id,case_id,id)
);
ALTER TABLE ledger_restore_execution_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_restore_execution_reviews FORCE ROW LEVEL SECURITY;
REVOKE ALL ON ledger_restore_execution_reviews FROM PUBLIC,autoreply_app,autoreply_admin,autoreply_learning_worker,autoreply_restore_reader;
DROP TRIGGER IF EXISTS restore_history_immutable ON ledger_restore_execution_reviews;
CREATE TRIGGER restore_history_immutable BEFORE UPDATE OR DELETE ON ledger_restore_execution_reviews
 FOR EACH ROW EXECUTE FUNCTION restore_history_immutable();
-- Read-only service access still authenticates the actual administrator login and tenant.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename='ledger_restore_execution_reviews' AND policyname='admin_login_scope') THEN
  CREATE POLICY admin_login_scope ON ledger_restore_execution_reviews TO autoreply_admin
  USING(tenant_id=current_setting('app.tenant_id',true) AND EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id))) WITH CHECK(false);
 END IF;
END $$;
GRANT SELECT ON ledger_restore_execution_reviews TO autoreply_admin;
