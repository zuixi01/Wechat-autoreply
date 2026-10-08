SET search_path=autoreply,public;
-- Final decisions and device acknowledgments are separate, append-only facts.
-- Never rewrite an original unknown receipt, and never resume an account here.
CREATE TABLE IF NOT EXISTS reconciliation_decisions (
  tenant_id text NOT NULL,account_id text NOT NULL,id text NOT NULL,case_id text NOT NULL,
  permit_id text NOT NULL,agent_id text NOT NULL,snapshot_hash text NOT NULL,report_hash text NOT NULL,
  note_id text NOT NULL,outcome text NOT NULL CHECK(outcome IN ('confirmed','not_sent')),
  decided_by text NOT NULL,decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decision_json jsonb NOT NULL,
  PRIMARY KEY(tenant_id,account_id,id),UNIQUE(tenant_id,account_id,case_id),UNIQUE(tenant_id,account_id,permit_id),
  FOREIGN KEY(tenant_id,account_id,case_id,snapshot_hash) REFERENCES reconciliation_cases(tenant_id,account_id,id,snapshot_hash),
  FOREIGN KEY(tenant_id,account_id,case_id) REFERENCES device_reconciliation_reports(tenant_id,account_id,case_id),
  FOREIGN KEY(tenant_id,account_id,note_id) REFERENCES reconciliation_notes(tenant_id,account_id,id),
  FOREIGN KEY(tenant_id,account_id,permit_id) REFERENCES execution_permits(tenant_id,account_id,id),
  FOREIGN KEY(tenant_id,decided_by) REFERENCES employees(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS reconciliation_applied (
  tenant_id text NOT NULL,account_id text NOT NULL,decision_id text NOT NULL,agent_id text NOT NULL,
  decision_hash text NOT NULL CHECK(decision_hash ~ '^[a-f0-9]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,account_id,decision_id),
  FOREIGN KEY(tenant_id,account_id,decision_id) REFERENCES reconciliation_decisions(tenant_id,account_id,id),
  FOREIGN KEY(tenant_id,agent_id,account_id) REFERENCES agents(tenant_id,id,account_id)
);
ALTER TABLE reconciliation_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_decisions FORCE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_applied ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_applied FORCE ROW LEVEL SECURITY;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['reconciliation_decisions','reconciliation_applied'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename=t AND policyname='tenant_scope') THEN
      EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=current_setting(''app.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''app.tenant_id'',true))',t);
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename=t AND policyname='admin_login_scope') THEN
      EXECUTE format('CREATE POLICY admin_login_scope ON %I AS RESTRICTIVE TO autoreply_admin USING(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id))) WITH CHECK(false)',t);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON reconciliation_decisions,reconciliation_applied FROM PUBLIC,autoreply_admin,autoreply_app;
GRANT SELECT ON reconciliation_decisions,reconciliation_applied TO autoreply_app,autoreply_admin;
GRANT INSERT ON reconciliation_applied TO autoreply_app;

CREATE OR REPLACE FUNCTION autoreply.decide_reconciliation(
  p_tenant text,p_account text,p_case uuid,p_id uuid,p_snapshot text,p_report text,p_note uuid,p_outcome text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,autoreply,pg_temp AS $$
DECLARE actor text; c record; p record; r record; n record; previous record; result jsonb; now_ms bigint;
BEGIN
  SELECT a.actor_id INTO actor FROM autoreply.authenticate_admin(p_tenant) a;
  IF actor IS NULL OR current_setting('app.tenant_id',true) IS DISTINCT FROM p_tenant THEN
    RAISE EXCEPTION 'reconciliation_denied';
  END IF;
  PERFORM 1 FROM autoreply.accounts WHERE tenant_id=p_tenant AND id=p_account FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'reconciliation_conflict'; END IF;
  SELECT * INTO c FROM autoreply.reconciliation_cases WHERE tenant_id=p_tenant AND account_id=p_account AND id=p_case::text;
  SELECT * INTO r FROM autoreply.device_reconciliation_reports WHERE tenant_id=p_tenant AND account_id=p_account AND case_id=p_case::text;
  SELECT * INTO n FROM autoreply.reconciliation_notes WHERE tenant_id=p_tenant AND account_id=p_account AND id=p_note::text;
  SELECT * INTO p FROM autoreply.execution_permits WHERE tenant_id=p_tenant AND account_id=p_account AND id=c.permit_id;
  IF c.id IS NULL OR r.case_id IS NULL OR n.id IS NULL OR p.id IS NULL OR
     c.snapshot_hash IS DISTINCT FROM p_snapshot OR r.snapshot_hash IS DISTINCT FROM p_snapshot OR
     r.report_hash IS DISTINCT FROM p_report OR n.snapshot_hash IS DISTINCT FROM p_snapshot OR
     n.case_id IS DISTINCT FROM p_case::text OR p_outcome NOT IN ('confirmed','not_sent') OR
     r.report_json->'observation'->>'status' IS DISTINCT FROM p_outcome OR
     r.agent_id IS DISTINCT FROM p.agent_id OR n.recorded_by IS DISTINCT FROM actor OR
     n.observed_at < to_timestamp((r.report_json->'observation'->>'observedAt')::numeric/1000.0) OR
     n.observed_at > clock_timestamp() THEN RAISE EXCEPTION 'reconciliation_conflict'; END IF;
  SELECT * INTO previous FROM autoreply.reconciliation_decisions WHERE tenant_id=p_tenant AND account_id=p_account AND case_id=p_case::text;
  IF FOUND THEN
    IF previous.id IS DISTINCT FROM p_id::text OR previous.report_hash IS DISTINCT FROM p_report OR
       previous.snapshot_hash IS DISTINCT FROM p_snapshot OR previous.note_id IS DISTINCT FROM p_note::text OR
       previous.outcome IS DISTINCT FROM p_outcome OR previous.decided_by IS DISTINCT FROM actor THEN
      RAISE EXCEPTION 'reconciliation_conflict';
    END IF;
    RETURN previous.decision_json;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM autoreply.accounts WHERE tenant_id=p_tenant AND id=p_account AND paused) OR
     p.status NOT IN ('issued','unknown') OR p.expires_at IS NULL OR p.expires_at>clock_timestamp() OR
     EXISTS(SELECT 1 FROM autoreply.account_leases WHERE tenant_id=p_tenant AND account_id=p_account AND expires_at>clock_timestamp()) OR
     r.report_json->'stopped'->>'observerStopped' IS DISTINCT FROM 'true' OR
     r.report_json->'stopped'->>'senderQuiescent' IS DISTINCT FROM 'true' OR
     r.report_json->'stopped'->>'settlementQuiescent' IS DISTINCT FROM 'true' OR
     r.report_json->'stopped'->>'leaseStopped' IS DISTINCT FROM 'true' OR
     r.report_json->'stopped'->>'verifiedDriverStopped' IS DISTINCT FROM 'true' OR
     r.report_json->'observation'->>'permitId' IS DISTINCT FROM p.id OR
     r.report_json->'observation'->>'conversationId' IS DISTINCT FROM p.conversation_id OR
     r.report_json->'observation'->>'taskHash' IS DISTINCT FROM p.task_hash OR
     r.report_json->'observation'->>'draftHash' IS DISTINCT FROM p.draft_hash OR
     r.report_json#>>'{observation,identity,tenantId}' IS DISTINCT FROM p_tenant OR
     r.report_json#>>'{observation,identity,accountId}' IS DISTINCT FROM p_account OR
     r.report_json#>>'{observation,identity,agentId}' IS DISTINCT FROM p.agent_id OR
     r.report_json#>>'{observation,identity,loginEpoch}' IS DISTINCT FROM p.login_epoch::text OR
     r.report_json#>>'{observation,identity,clientInstanceId}' IS DISTINCT FROM p.client_instance_id OR
     r.report_json#>>'{observation,draftRevision}' IS DISTINCT FROM p.draft_revision::text OR
     r.report_json#>>'{observation,leaseVersion}' IS DISTINCT FROM p.lease_version::text OR
     r.report_json#>>'{request,taskId}' IS DISTINCT FROM p.task_id OR
     r.report_json#>>'{request,taskHash}' IS DISTINCT FROM p.task_hash OR
     r.report_json#>>'{request,draftHash}' IS DISTINCT FROM p.draft_hash OR
     r.report_json#>>'{request,draftRevision}' IS DISTINCT FROM p.draft_revision::text OR
     r.report_json#>>'{request,leaseVersion}' IS DISTINCT FROM p.lease_version::text OR
     r.report_json#>>'{request,loginEpoch}' IS DISTINCT FROM p.login_epoch::text OR
     r.report_json#>>'{request,clientInstanceId}' IS DISTINCT FROM p.client_instance_id OR
     COALESCE(r.report_json#>>'{request,purpose}','automatic') IS DISTINCT FROM p.purpose OR
     r.report_json#>>'{request,confirmationId}' IS DISTINCT FROM p.confirmation_id OR
     r.report_json#>>'{stopped,stoppedAt}' IS NULL OR r.report_json#>>'{observation,observedAt}' IS NULL OR
     (r.report_json#>>'{stopped,stoppedAt}')::numeric<GREATEST(floor(extract(epoch FROM c.opened_at)*1000),floor(extract(epoch FROM p.expires_at)*1000)) OR
     (r.report_json#>>'{observation,observedAt}')::numeric < (r.report_json#>>'{stopped,stoppedAt}')::numeric OR
     to_timestamp((r.report_json#>>'{observation,observedAt}')::numeric/1000.0)>clock_timestamp() OR
     (p_outcome='not_sent' AND (r.report_json#>>'{observation,dispatchStarted}' IS DISTINCT FROM 'false' OR
       r.report_json#>>'{observation,quiescent}' IS DISTINCT FROM 'true')) OR
     (p_outcome='confirmed' AND COALESCE(r.report_json#>>'{observation,sourceMessageId}','')='') THEN
    RAISE EXCEPTION 'reconciliation_not_ready';
  END IF;
  now_ms:=floor(extract(epoch FROM clock_timestamp())*1000);
  result:=jsonb_build_object('decisionId',p_id::text,'caseId',p_case::text,'snapshotHash',p_snapshot,
    'reportHash',p_report,'noteId',p_note::text,'outcome',p_outcome,'decidedBy',actor,'decidedAt',now_ms);
  INSERT INTO autoreply.reconciliation_decisions(tenant_id,account_id,id,case_id,permit_id,agent_id,snapshot_hash,report_hash,note_id,outcome,decided_by,decided_at,decision_json)
    VALUES(p_tenant,p_account,p_id::text,p_case::text,p.id,p.agent_id,p_snapshot,p_report,p_note::text,p_outcome,actor,to_timestamp(now_ms/1000.0),result);
  INSERT INTO autoreply.audit_events(tenant_id,id,actor_id,kind,account_id,details_json)
    VALUES(p_tenant,p_id::text,actor,'reconciliation_decided',p_account,result);
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION autoreply.decide_reconciliation(text,text,uuid,uuid,text,text,uuid,text) FROM PUBLIC,autoreply_app;
GRANT EXECUTE ON FUNCTION autoreply.decide_reconciliation(text,text,uuid,uuid,text,text,uuid,text) TO autoreply_admin;
