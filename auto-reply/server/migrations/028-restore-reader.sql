SET search_path=autoreply,public;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'restore_reader_owner_invalid'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='autoreply_restore_reader') THEN CREATE ROLE autoreply_restore_reader NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
END $$;
-- App transactions explicitly narrow to a read-only role, never inherit its protected reads.
GRANT autoreply_restore_reader TO autoreply_app WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
GRANT USAGE ON SCHEMA autoreply TO autoreply_restore_reader;
GRANT EXECUTE ON FUNCTION autoreply.authenticate_device(text) TO autoreply_restore_reader;
CREATE OR REPLACE FUNCTION autoreply.restore_reader_scope(p_tenant text,p_account text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,autoreply AS $$
 SELECT EXISTS(SELECT 1 FROM autoreply.authenticate_device(current_setting('app.restore_read_credential_hash',true)) s
 JOIN ledger_restore_reviews r ON r.tenant_id=s.tenant_id AND r.account_id=s.account_id AND r.agent_id=s.agent_id
 JOIN accounts a ON a.tenant_id=s.tenant_id AND a.id=s.account_id
 WHERE s.tenant_id=p_tenant AND s.account_id=p_account AND a.paused
 AND r.id::text=current_setting('app.restore_read_case_id',true))
$$;
REVOKE ALL ON FUNCTION autoreply.restore_reader_scope(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION autoreply.restore_reader_scope(text,text) TO autoreply_restore_reader;
DO $$ DECLARE t text; guard text; BEGIN
 FOREACH t IN ARRAY ARRAY['ledger_restore_reviews','ledger_restore_review_permits','ledger_restore_challenges','ledger_restore_pause_reports','ledger_restore_inventory_uploads','ledger_restore_inventory_pages','ledger_restore_inventory_items','ledger_restore_inventory_receipts','ledger_restore_evidence','ledger_restore_rulings','ledger_restore_decisions','accounts','agents','account_leases','execution_permits','employees'] LOOP
  IF t='accounts' THEN guard:='autoreply.restore_reader_scope(tenant_id,id)';
  ELSIF t='employees' THEN guard:='EXISTS(SELECT 1 FROM autoreply.authenticate_device(current_setting(''app.restore_read_credential_hash'',true)) s WHERE s.tenant_id=employees.tenant_id AND s.employee_id=employees.id AND autoreply.restore_reader_scope(s.tenant_id,s.account_id))';
  ELSE guard:='autoreply.restore_reader_scope(tenant_id,account_id)'; END IF;
  IF t='ledger_restore_reviews' THEN guard:=guard||' AND id::text=current_setting(''app.restore_read_case_id'',true)';
  ELSIF t IN ('ledger_restore_review_permits','ledger_restore_challenges','ledger_restore_inventory_uploads','ledger_restore_evidence','ledger_restore_rulings','ledger_restore_decisions') THEN guard:=guard||' AND case_id::text=current_setting(''app.restore_read_case_id'',true)';
  ELSIF t='ledger_restore_pause_reports' THEN guard:=guard||' AND EXISTS(SELECT 1 FROM ledger_restore_challenges c WHERE (c.tenant_id,c.account_id,c.id)=(ledger_restore_pause_reports.tenant_id,ledger_restore_pause_reports.account_id,ledger_restore_pause_reports.challenge_id))';
  ELSIF t IN ('ledger_restore_inventory_pages','ledger_restore_inventory_items','ledger_restore_inventory_receipts') THEN guard:=guard||format(' AND EXISTS(SELECT 1 FROM ledger_restore_inventory_uploads u WHERE (u.tenant_id,u.account_id,u.id)=(%I.tenant_id,%I.account_id,%I.upload_id))',t,t,t); END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename=t AND policyname='restore_reader_scope') THEN
   EXECUTE format('CREATE POLICY restore_reader_scope ON %I AS RESTRICTIVE TO autoreply_restore_reader USING(%s) WITH CHECK(false)',t,guard);
  END IF;
  EXECUTE format('REVOKE ALL ON %I FROM autoreply_restore_reader',t);
  IF t='agents' THEN EXECUTE 'GRANT SELECT(tenant_id,account_id,id,employee_id,revoked_at) ON agents TO autoreply_restore_reader';
  ELSE EXECUTE format('GRANT SELECT ON %I TO autoreply_restore_reader',t); END IF;
 END LOOP;
END $$;
-- No write, enrollment, lease, send, admin, learning-worker or BYPASSRLS authority is granted.
