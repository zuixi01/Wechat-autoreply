SET search_path=autoreply,public;
-- Separate migration/maintenance authority; never grant facts registration to a service login.
CREATE TABLE IF NOT EXISTS restore_history_maintenance_records (
 id uuid PRIMARY KEY,kind text NOT NULL CHECK(kind IN ('requirement','key_revocation')),
 tenant_id text,account_id text,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 request_json jsonb NOT NULL CHECK(jsonb_typeof(request_json)='object' AND octet_length(request_json::text)<=16384),
 receipt_hash text NOT NULL CHECK(receipt_hash ~ '^[a-f0-9]{64}$'),
 receipt_json jsonb NOT NULL CHECK(jsonb_typeof(receipt_json)='object' AND octet_length(receipt_json::text)<=16384),
 recorded_by text NOT NULL,recorded_at timestamptz NOT NULL,
 CHECK((kind='requirement' AND tenant_id IS NOT NULL AND account_id IS NOT NULL) OR
       (kind='key_revocation' AND tenant_id IS NULL AND account_id IS NULL)),
 FOREIGN KEY(tenant_id,account_id) REFERENCES accounts(tenant_id,id)
);
ALTER TABLE restore_history_maintenance_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE restore_history_maintenance_records FORCE ROW LEVEL SECURITY;
REVOKE ALL ON restore_history_maintenance_records FROM PUBLIC,autoreply_app,autoreply_admin,autoreply_learning_worker,autoreply_restore_reader;
DROP TRIGGER IF EXISTS restore_history_immutable ON restore_history_maintenance_records;
CREATE TRIGGER restore_history_immutable BEFORE UPDATE OR DELETE ON restore_history_maintenance_records
 FOR EACH ROW EXECUTE FUNCTION restore_history_immutable();
-- No service RLS policy or writing privilege; existing history and send guards remain in force.
