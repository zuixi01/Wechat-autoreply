SET search_path=autoreply,public;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'restore_admission_owner_invalid'; END IF;
END $$;
-- Ordinary raw SQL writes cannot bypass the common service admission check.
-- Actual migration-owner fixture/bootstrap SQL remains a trusted maintenance operation.
CREATE OR REPLACE FUNCTION autoreply.guard_restore_admission_execution() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,autoreply AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND rolsuper AND rolcanlogin)
 AND current_setting('role',true)='none' THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='account_leases' AND TG_OP='UPDATE' THEN
  -- Stopping or revoking a holder must remain possible after admission becomes invalid.
  IF (NEW.tenant_id,NEW.account_id,NEW.agent_id,NEW.login_epoch,NEW.client_instance_id,NEW.version)
   IS NOT DISTINCT FROM (OLD.tenant_id,OLD.account_id,OLD.agent_id,OLD.login_epoch,OLD.client_instance_id,OLD.version)
   AND NEW.expires_at<=OLD.expires_at THEN RETURN NEW; END IF;
 END IF;
 IF TG_TABLE_NAME='execution_permits' THEN
  IF NEW.status<>'issued' THEN RETURN NEW; END IF;
  IF EXISTS(SELECT 1 FROM ledger_restore_admission_permits WHERE tenant_id=NEW.tenant_id AND account_id=NEW.account_id AND permit_id=NEW.id) THEN RAISE EXCEPTION 'restored_permit_replay_denied'; END IF;
 END IF;
 PERFORM 1 FROM accounts WHERE tenant_id=NEW.tenant_id AND id=NEW.account_id FOR UPDATE;
 IF NOT autoreply.restore_admission_current(NEW.tenant_id,NEW.account_id,NEW.agent_id) THEN RAISE EXCEPTION 'ledger_restore_review_pending'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION autoreply.guard_restore_admission_execution() FROM PUBLIC;
DROP TRIGGER IF EXISTS restore_admission_execution_guard ON account_leases;
CREATE TRIGGER restore_admission_execution_guard BEFORE INSERT OR UPDATE ON account_leases FOR EACH ROW EXECUTE FUNCTION guard_restore_admission_execution();
DROP TRIGGER IF EXISTS restore_admission_execution_guard ON execution_permits;
CREATE TRIGGER restore_admission_execution_guard BEFORE INSERT OR UPDATE ON execution_permits FOR EACH ROW EXECUTE FUNCTION guard_restore_admission_execution();
CREATE TABLE IF NOT EXISTS ledger_restore_admissions (
 tenant_id text NOT NULL,account_id text NOT NULL,approval_id uuid NOT NULL,agent_id text NOT NULL,
 request_hash text NOT NULL,request_json jsonb NOT NULL CHECK(octet_length(request_json::text)<=16384),
 receipt_hash text NOT NULL,receipt_json jsonb NOT NULL CHECK(octet_length(receipt_json::text)<=1048576),
 storage_hash text NOT NULL,recorded_by text NOT NULL,recorded_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,account_id,approval_id),
 FOREIGN KEY(tenant_id,agent_id,account_id) REFERENCES agents(tenant_id,id,account_id)
);
CREATE INDEX IF NOT EXISTS ledger_restore_admissions_latest ON ledger_restore_admissions(tenant_id,account_id,recorded_at DESC,approval_id DESC);
CREATE TABLE IF NOT EXISTS ledger_restore_admission_cases (
 tenant_id text NOT NULL,account_id text NOT NULL,approval_id uuid NOT NULL,case_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,account_id,approval_id,case_id),
 FOREIGN KEY(tenant_id,account_id,approval_id) REFERENCES ledger_restore_admissions(tenant_id,account_id,approval_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,account_id,case_id) REFERENCES ledger_restore_reviews(tenant_id,account_id,id)
);
CREATE TABLE IF NOT EXISTS ledger_restore_admission_keys (
 tenant_id text NOT NULL,account_id text NOT NULL,approval_id uuid NOT NULL,key_sha256 text NOT NULL CHECK(key_sha256 ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(tenant_id,account_id,approval_id,key_sha256),
 FOREIGN KEY(tenant_id,account_id,approval_id) REFERENCES ledger_restore_admissions(tenant_id,account_id,approval_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE IF NOT EXISTS ledger_restore_admission_permits (
 tenant_id text NOT NULL,account_id text NOT NULL,approval_id uuid NOT NULL,permit_id text NOT NULL,
 PRIMARY KEY(tenant_id,account_id,approval_id,permit_id),
 FOREIGN KEY(tenant_id,account_id,approval_id) REFERENCES ledger_restore_admissions(tenant_id,account_id,approval_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,account_id,permit_id) REFERENCES execution_permits(tenant_id,account_id,id)
);
CREATE TABLE IF NOT EXISTS ledger_restore_admission_seals (
 tenant_id text NOT NULL,account_id text NOT NULL,approval_id uuid NOT NULL,seal_id text NOT NULL,
 PRIMARY KEY(tenant_id,account_id,approval_id,seal_id),
 FOREIGN KEY(tenant_id,account_id,approval_id) REFERENCES ledger_restore_admissions(tenant_id,account_id,approval_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,account_id,seal_id) REFERENCES execution_request_seals(tenant_id,account_id,id)
);
CREATE TABLE IF NOT EXISTS ledger_restore_admission_invalidations (
 tenant_id text NOT NULL,account_id text NOT NULL,approval_id uuid NOT NULL,source_kind text NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,account_id,approval_id,source_kind),
 FOREIGN KEY(tenant_id,account_id,approval_id) REFERENCES ledger_restore_admissions(tenant_id,account_id,approval_id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['ledger_restore_admissions','ledger_restore_admission_cases','ledger_restore_admission_keys','ledger_restore_admission_permits','ledger_restore_admission_seals','ledger_restore_admission_invalidations'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,autoreply_app,autoreply_admin,autoreply_restore_reader,autoreply_learning_worker',t);
  EXECUTE format('DROP TRIGGER IF EXISTS restore_history_immutable ON %I',t);
  EXECUTE format('CREATE TRIGGER restore_history_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION restore_history_immutable()',t);
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename='ledger_restore_admissions' AND policyname='admin_read') THEN
 CREATE POLICY admin_read ON ledger_restore_admissions TO autoreply_admin USING(tenant_id=current_setting('app.tenant_id',true) AND EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id))) WITH CHECK(false);
 END IF;
END $$;
GRANT SELECT ON ledger_restore_admissions TO autoreply_admin;

-- Internal guard: immutable independent approval, exact case set, original subject sets,
-- target identity and invalidations. Historical proof expiry does not renew a source grant.
CREATE OR REPLACE FUNCTION autoreply.restore_admission_current(p_tenant text,p_account text,p_agent text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,autoreply AS $$
DECLARE a ledger_restore_admissions%ROWTYPE;k text;expected text; BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM ledger_restore_reviews WHERE tenant_id=p_tenant AND account_id=p_account) THEN RETURN true; END IF;
 SELECT * INTO a FROM ledger_restore_admissions WHERE tenant_id=p_tenant AND account_id=p_account ORDER BY recorded_at DESC,approval_id DESC LIMIT 1;
 IF NOT FOUND THEN RETURN false; END IF;
 FOR k IN SELECT key_sha256 FROM ledger_restore_admission_keys WHERE (tenant_id,account_id,approval_id)=(p_tenant,p_account,a.approval_id) ORDER BY key_sha256 LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('autoreply.restore-history-key.v1:'||k,0));
 END LOOP;
 expected:=encode(sha256(convert_to(jsonb_build_object('request',a.request_json,'receipt',a.receipt_json)::text,'UTF8')),'hex');
 IF jsonb_typeof(a.request_json) IS DISTINCT FROM 'object'
 OR jsonb_typeof(a.receipt_json) IS DISTINCT FROM 'object'
 OR jsonb_typeof(a.receipt_json->'scope') IS DISTINCT FROM 'object'
 OR jsonb_typeof(a.receipt_json->'cases') IS DISTINCT FROM 'array'
 OR jsonb_typeof(a.receipt_json->'sourceKeyHashes') IS DISTINCT FROM 'array'
 OR a.request_json->'completeAccountCasesVerified' IS DISTINCT FROM 'true'::jsonb
 OR a.request_json->'physicalDurabilityIndependentlyVerified' IS DISTINCT FROM 'true'::jsonb
 THEN RETURN false; END IF;
 IF expected IS DISTINCT FROM a.storage_hash OR a.receipt_json->>'approvalId' IS DISTINCT FROM a.approval_id::text
 OR a.receipt_json->>'requestHash' IS DISTINCT FROM a.request_hash OR a.receipt_json->>'recordedBy' IS DISTINCT FROM a.recorded_by
 OR a.receipt_json->>'status' IS DISTINCT FROM 'account_restore_admission_approved'
 OR a.receipt_json->'formatVersion' IS DISTINCT FROM '1'::jsonb
 OR a.receipt_json->'centralAdmissionApproved' IS DISTINCT FROM 'true'::jsonb
 OR a.receipt_json->'localAdmissionRequired' IS DISTINCT FROM 'true'::jsonb
 OR a.receipt_json->'physicalVerificationPerformedByThisCommand' IS DISTINCT FROM 'false'::jsonb
 OR a.receipt_json->'automaticStart' IS DISTINCT FROM 'false'::jsonb
 OR a.receipt_json->'scope'->>'tenant_id' IS DISTINCT FROM p_tenant OR a.receipt_json->'scope'->>'account_id' IS DISTINCT FROM p_account
 OR a.receipt_json->'scope'->>'agent_id' IS DISTINCT FROM a.agent_id OR (p_agent IS NOT NULL AND p_agent<>a.agent_id)
 OR EXISTS(SELECT 1 FROM ledger_restore_admission_invalidations WHERE (tenant_id,account_id,approval_id)=(p_tenant,p_account,a.approval_id))
 OR NOT EXISTS(SELECT 1 FROM accounts c JOIN employees e ON (e.tenant_id,e.id)=(c.tenant_id,c.employee_id)
 JOIN agents g ON (g.tenant_id,g.account_id,g.id)=(c.tenant_id,c.id,a.agent_id)
 WHERE (c.tenant_id,c.id)=(p_tenant,p_account) AND c.enabled AND e.enabled AND g.revoked_at IS NULL
 AND c.employee_id=a.receipt_json->'scope'->>'employee_id' AND c.platform=a.receipt_json->'scope'->>'platform')
 THEN RETURN false; END IF;
 IF jsonb_array_length(a.receipt_json->'cases')=0 OR jsonb_array_length(a.receipt_json->'sourceKeyHashes')=0
 OR (SELECT count(DISTINCT x->>'caseId') FROM jsonb_array_elements(a.receipt_json->'cases') x)<>jsonb_array_length(a.receipt_json->'cases')
 OR (SELECT count(*) FROM ledger_restore_reviews WHERE tenant_id=p_tenant AND account_id=p_account)<>jsonb_array_length(a.receipt_json->'cases')
 OR (SELECT count(*) FROM ledger_restore_admission_cases WHERE (tenant_id,account_id,approval_id)=(p_tenant,p_account,a.approval_id))<>jsonb_array_length(a.receipt_json->'cases')
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(a.receipt_json->'cases') x LEFT JOIN ledger_restore_admission_cases b
 ON (b.tenant_id,b.account_id,b.approval_id,b.case_id)=(p_tenant,p_account,a.approval_id,(x->>'caseId')::uuid) WHERE b.case_id IS NULL)
 OR (SELECT count(*) FROM ledger_restore_admission_keys WHERE (tenant_id,account_id,approval_id)=(p_tenant,p_account,a.approval_id))<>jsonb_array_length(a.receipt_json->'sourceKeyHashes')
 OR EXISTS(SELECT 1 FROM ledger_restore_admission_keys b WHERE (b.tenant_id,b.account_id,b.approval_id)=(p_tenant,p_account,a.approval_id)
 AND (NOT ((a.receipt_json->'sourceKeyHashes') ? b.key_sha256) OR EXISTS(SELECT 1 FROM restore_history_key_revocations r WHERE r.key_sha256=b.key_sha256))) THEN RETURN false; END IF;
 -- Subject membership is immutable. Every attempted post-seal insertion or mutation
 -- invalidates the exact approval, rather than rehashing all old permits per lease.
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false; END $$;
REVOKE ALL ON FUNCTION autoreply.restore_admission_current(text,text,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION autoreply.restore_admission_pending(p_tenant text,p_account text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,autoreply AS $$
DECLARE agent text; BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND rolsuper AND rolcanlogin)
 OR EXISTS(SELECT 1 FROM autoreply.authenticate_admin(p_tenant)) THEN RETURN NOT autoreply.restore_admission_current(p_tenant,p_account,NULL); END IF;
 SELECT agent_id INTO agent FROM autoreply.authenticate_device(current_setting('app.restore_admission_credential_hash',true)) WHERE tenant_id=p_tenant AND account_id=p_account;
 IF agent IS NULL THEN RAISE EXCEPTION 'restore_admission_denied'; END IF;
 RETURN NOT autoreply.restore_admission_current(p_tenant,p_account,agent);
END $$;
REVOKE ALL ON FUNCTION autoreply.restore_admission_pending(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION autoreply.restore_admission_pending(text,text) TO autoreply_admin,autoreply_app;

CREATE OR REPLACE FUNCTION autoreply.guard_ledger_restore_pause() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,autoreply AS $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'ledger_restore_guard_owner_invalid';
  END IF;
 IF NOT NEW.paused AND NOT autoreply.restore_admission_current(NEW.tenant_id,NEW.id,NULL) THEN RAISE EXCEPTION 'ledger_restore_review_pending'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION autoreply.guard_ledger_restore_pause() FROM PUBLIC;

CREATE OR REPLACE FUNCTION autoreply.invalidate_restore_admission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,autoreply AS $$
DECLARE r jsonb;permit text;seal text; BEGIN
 r:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 IF TG_TABLE_NAME IN ('ledger_restore_admission_cases','ledger_restore_admission_keys','ledger_restore_admission_permits','ledger_restore_admission_seals') THEN
  INSERT INTO ledger_restore_admission_invalidations(tenant_id,account_id,approval_id,source_kind)
  SELECT tenant_id,account_id,approval_id,TG_TABLE_NAME FROM ledger_restore_admissions
  WHERE tenant_id=r->>'tenant_id' AND account_id=r->>'account_id' AND approval_id=(r->>'approval_id')::uuid ON CONFLICT DO NOTHING;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='accounts' THEN
  IF TG_OP='UPDATE' AND (NEW.employee_id,NEW.platform,NEW.enabled) IS NOT DISTINCT FROM (OLD.employee_id,OLD.platform,OLD.enabled) THEN RETURN NEW; END IF;
  r:=r||jsonb_build_object('account_id',r->>'id');
 ELSIF TG_TABLE_NAME='execution_permits' THEN
  IF TG_OP='INSERT' THEN RETURN NEW; END IF;permit:=r->>'id';
 ELSIF TG_TABLE_NAME IN ('reconciliation_cases','reconciliation_decisions') THEN permit:=r->>'permit_id';
 ELSIF TG_TABLE_NAME IN ('reconciliation_notes','device_reconciliation_reports') THEN
  SELECT permit_id INTO permit FROM reconciliation_cases WHERE tenant_id=r->>'tenant_id' AND account_id=r->>'account_id' AND id=r->>'case_id';
 ELSIF TG_TABLE_NAME='reconciliation_applied' THEN
  SELECT permit_id INTO permit FROM reconciliation_decisions WHERE tenant_id=r->>'tenant_id' AND account_id=r->>'account_id' AND id=r->>'decision_id';
 ELSIF TG_TABLE_NAME='execution_request_seals' THEN seal:=r->>'id';
 ELSIF TG_TABLE_NAME='execution_request_seal_applications' THEN seal:=r->>'seal_id'; END IF;
 INSERT INTO ledger_restore_admission_invalidations(tenant_id,account_id,approval_id,source_kind)
 SELECT a.tenant_id,a.account_id,a.approval_id,TG_TABLE_NAME FROM ledger_restore_admissions a
 WHERE a.tenant_id=r->>'tenant_id' AND a.account_id=r->>'account_id'
 AND (permit IS NULL OR EXISTS(SELECT 1 FROM ledger_restore_admission_permits p WHERE (p.tenant_id,p.account_id,p.approval_id,p.permit_id)=(a.tenant_id,a.account_id,a.approval_id,permit)))
 AND (seal IS NULL OR EXISTS(SELECT 1 FROM ledger_restore_admission_seals s WHERE (s.tenant_id,s.account_id,s.approval_id,s.seal_id)=(a.tenant_id,a.account_id,a.approval_id,seal)))
 AND (TG_TABLE_NAME NOT IN ('reconciliation_cases','reconciliation_notes','reconciliation_decisions','reconciliation_applied','device_reconciliation_reports') OR permit IS NOT NULL)
 ON CONFLICT DO NOTHING;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION autoreply.invalidate_restore_admission() FROM PUBLIC;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['ledger_restore_reviews','ledger_restore_review_permits','ledger_restore_recovery_authorizations','ledger_restore_recovery_completions','ledger_restore_history_requirements','ledger_restore_history_proofs','ledger_restore_execution_reviews','accounts','agents','execution_permits','reconciliation_cases','reconciliation_notes','device_reconciliation_reports','reconciliation_decisions','reconciliation_applied','execution_request_seals','execution_request_seal_applications','ledger_restore_admission_cases','ledger_restore_admission_keys','ledger_restore_admission_permits','ledger_restore_admission_seals'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS restore_admission_invalidation ON %I',t);
  EXECUTE format('CREATE TRIGGER restore_admission_invalidation AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION invalidate_restore_admission()',t);
 END LOOP;
END $$;
