SET search_path=autoreply,public;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'restore_completion_owner_invalid'; END IF;
END $$;
CREATE TABLE IF NOT EXISTS ledger_restore_recovery_completions (
 tenant_id text NOT NULL,account_id text NOT NULL,case_id uuid NOT NULL,agent_id text NOT NULL,
 authorization_id uuid NOT NULL,completion_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 request_json jsonb NOT NULL CHECK(jsonb_typeof(request_json)='object' AND octet_length(request_json::text)<=1048576),
 receipt_hash text NOT NULL CHECK(receipt_hash ~ '^[a-f0-9]{64}$'),
 receipt_json jsonb NOT NULL CHECK(jsonb_typeof(receipt_json)='object' AND octet_length(receipt_json::text)<=16384),
 recorded_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,account_id,completion_id),UNIQUE(tenant_id,account_id,authorization_id),
 FOREIGN KEY(tenant_id,account_id,authorization_id) REFERENCES ledger_restore_recovery_authorizations(tenant_id,account_id,authorization_id),
 FOREIGN KEY(tenant_id,account_id,case_id) REFERENCES ledger_restore_reviews(tenant_id,account_id,id),
 FOREIGN KEY(tenant_id,agent_id,account_id) REFERENCES agents(tenant_id,id,account_id)
);
ALTER TABLE ledger_restore_recovery_completions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_restore_recovery_completions FORCE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION autoreply.restore_completion_scope(p_tenant text,p_account text,p_case uuid,p_agent text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,autoreply AS $$
 SELECT EXISTS(SELECT 1 FROM autoreply.authenticate_device(current_setting('app.restore_read_credential_hash',true)) s
 JOIN ledger_restore_reviews r ON (r.tenant_id,r.account_id,r.agent_id)=(s.tenant_id,s.account_id,s.agent_id)
 WHERE (s.tenant_id,s.account_id,s.agent_id)=(p_tenant,p_account,p_agent) AND r.id=p_case
 AND r.id::text=current_setting('app.restore_read_case_id',true))
$$;
CREATE OR REPLACE FUNCTION autoreply.restore_completion_insert_scope(p_tenant text,p_account text,p_case uuid,p_agent text,p_auth uuid,p_auth_hash text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,autoreply AS $$
 SELECT autoreply.restore_completion_scope(p_tenant,p_account,p_case,p_agent) AND EXISTS(
 SELECT 1 FROM ledger_restore_recovery_authorizations a JOIN accounts c ON (c.tenant_id,c.id)=(a.tenant_id,a.account_id)
 WHERE (a.tenant_id,a.account_id,a.case_id,a.authorization_id)=(p_tenant,p_account,p_case,p_auth)
 AND a.receipt_hash=p_auth_hash AND c.paused AND a.recorded_at<=clock_timestamp() AND a.expires_at>clock_timestamp()
 AND NOT EXISTS(SELECT 1 FROM ledger_restore_recovery_authorizations n WHERE (n.tenant_id,n.account_id,n.case_id)=(a.tenant_id,a.account_id,a.case_id)
 AND (n.recorded_at,n.authorization_id)>(a.recorded_at,a.authorization_id)))
$$;
REVOKE ALL ON FUNCTION autoreply.restore_completion_scope(text,text,uuid,text),autoreply.restore_completion_insert_scope(text,text,uuid,text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION autoreply.restore_completion_scope(text,text,uuid,text),autoreply.restore_completion_insert_scope(text,text,uuid,text,uuid,text) TO autoreply_app;
CREATE OR REPLACE FUNCTION autoreply.restore_completion_authorization(p_tenant text,p_account text,p_case uuid,p_auth uuid)
RETURNS TABLE(receipt_json jsonb,receipt_hash text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,autoreply AS $$
 SELECT a.receipt_json,a.receipt_hash FROM ledger_restore_recovery_authorizations a JOIN ledger_restore_reviews r
 ON (r.tenant_id,r.account_id,r.id)=(a.tenant_id,a.account_id,a.case_id)
 WHERE (a.tenant_id,a.account_id,a.case_id,a.authorization_id)=(p_tenant,p_account,p_case,p_auth)
 AND autoreply.restore_completion_scope(p_tenant,p_account,p_case,r.agent_id)
$$;
REVOKE ALL ON FUNCTION autoreply.restore_completion_authorization(text,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION autoreply.restore_completion_authorization(text,text,uuid,uuid) TO autoreply_app;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename='ledger_restore_recovery_completions' AND policyname='target_completion') THEN
 CREATE POLICY target_completion ON ledger_restore_recovery_completions TO autoreply_app
 USING(tenant_id=current_setting('app.tenant_id',true) AND autoreply.restore_completion_scope(tenant_id,account_id,case_id,agent_id))
 WITH CHECK(tenant_id=current_setting('app.tenant_id',true) AND autoreply.restore_completion_insert_scope(tenant_id,account_id,case_id,agent_id,authorization_id,request_json->'boundaryApplication'->>'authorizationHash')
 AND request_json->'boundaryApplication'->>'authorizationId'=authorization_id::text
 AND request_json->>'completionId'=completion_id::text AND receipt_json->>'completionId'=completion_id::text
 AND receipt_json->>'status'='durable_recovery_recorded' AND receipt_json->>'canRelease'='false');
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename='ledger_restore_recovery_completions' AND policyname='admin_completion') THEN
 CREATE POLICY admin_completion ON ledger_restore_recovery_completions TO autoreply_admin
 USING(tenant_id=current_setting('app.tenant_id',true) AND EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id))) WITH CHECK(false);
 END IF;
END $$;
REVOKE ALL ON ledger_restore_recovery_completions FROM PUBLIC,autoreply_app,autoreply_admin,autoreply_restore_reader,autoreply_learning_worker;
GRANT SELECT,INSERT ON ledger_restore_recovery_completions TO autoreply_app;
GRANT SELECT ON ledger_restore_recovery_completions TO autoreply_admin;
DROP TRIGGER IF EXISTS restore_history_immutable ON ledger_restore_recovery_completions;
CREATE TRIGGER restore_history_immutable BEFORE UPDATE OR DELETE ON ledger_restore_recovery_completions FOR EACH ROW EXECUTE FUNCTION restore_history_immutable();
-- Device durability declaration only. No account/provenance/lease/send guard is relaxed here.
