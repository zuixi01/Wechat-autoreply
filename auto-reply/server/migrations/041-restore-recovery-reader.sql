SET search_path=autoreply,public;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'restore_reader_owner_invalid'; END IF;
END $$;
-- Inherited application authority remains unchanged. Protected reads require SET ROLE
-- and the credential-bound original paused restoration case from migration 028.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['ledger_restore_history_requirements','ledger_restore_history_proofs','ledger_restore_execution_reviews','ledger_restore_recovery_authorizations'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename=t AND policyname='restore_recovery_reader_scope') THEN
   EXECUTE format('CREATE POLICY restore_recovery_reader_scope ON %I AS RESTRICTIVE TO autoreply_restore_reader USING(tenant_id=current_setting(''app.tenant_id'',true) AND autoreply.restore_reader_scope(tenant_id,account_id) AND case_id::text=current_setting(''app.restore_read_case_id'',true)) WITH CHECK(false)',t);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename=t AND policyname='restore_recovery_reader_allowed') THEN
   EXECUTE format('CREATE POLICY restore_recovery_reader_allowed ON %I TO autoreply_restore_reader USING(true) WITH CHECK(false)',t);
  END IF;
  EXECUTE format('GRANT SELECT ON %I TO autoreply_restore_reader',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['reconciliation_cases','device_reconciliation_reports','reconciliation_notes','reconciliation_decisions','reconciliation_applied','execution_request_seals','execution_request_seal_applications'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename=t AND policyname='restore_recovery_reader_scope') THEN
   EXECUTE format('CREATE POLICY restore_recovery_reader_scope ON %I AS RESTRICTIVE TO autoreply_restore_reader USING(autoreply.restore_reader_scope(tenant_id,account_id)) WITH CHECK(false)',t);
  END IF;
  EXECUTE format('GRANT SELECT ON %I TO autoreply_restore_reader',t);
 END LOOP;
END $$;
-- Permit a single supplied-key revocation lookup, not enumeration of global keys or
-- maintenance record reads. Public keys and their revocations grant no source trust.
CREATE OR REPLACE FUNCTION autoreply.restore_recovery_key_revocation(p_key text)
RETURNS TABLE(recorded_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,autoreply AS $$ BEGIN
 IF p_key !~ '^[a-f0-9]{64}$' OR NOT autoreply.restore_reader_scope(current_setting('app.tenant_id',true),current_setting('app.restore_account_id',true)) THEN
  RAISE EXCEPTION 'restore_reader_denied';
 END IF;
 RETURN QUERY SELECT r.recorded_at FROM restore_history_key_revocations r WHERE r.key_sha256=p_key;
END $$;
REVOKE ALL ON FUNCTION autoreply.restore_recovery_key_revocation(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION autoreply.restore_recovery_key_revocation(text) TO autoreply_restore_reader;
-- No protected INSERT/UPDATE/DELETE, maintenance records, credential hashes,
-- enrollment, approval, completion, lease or send authority is granted.
