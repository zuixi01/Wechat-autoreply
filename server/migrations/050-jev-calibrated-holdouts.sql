SET search_path=autoreply,public;
-- Evaluation lineage, not a production approval. Final admission must recompute
-- calibration from the sealed original evidence and verify real billing.
CREATE TABLE IF NOT EXISTS jev_holdout_lineages (
  tenant_id text NOT NULL,account_id text NOT NULL,id uuid NOT NULL,
  source_run_id text NOT NULL,target_run_id text NOT NULL,packet_id uuid NOT NULL,review_id uuid NOT NULL,
  declaration_id uuid NOT NULL,settings_hash text NOT NULL,labels_hash text NOT NULL,
  report_canonical text NOT NULL CHECK(octet_length(report_canonical)<=1048576),report_json jsonb NOT NULL,
  report_hash text NOT NULL,input_hash text NOT NULL,source_snapshot_hash text NOT NULL,target_snapshot_hash text NOT NULL,
  actor_id text NOT NULL,login_name name NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,account_id,id),UNIQUE(tenant_id,account_id,source_run_id,review_id),
  UNIQUE(tenant_id,account_id,target_run_id),
  FOREIGN KEY(tenant_id,account_id,source_run_id) REFERENCES evaluation_runs(tenant_id,account_id,id),
  FOREIGN KEY(tenant_id,account_id,target_run_id) REFERENCES evaluation_runs(tenant_id,account_id,id),
  FOREIGN KEY(tenant_id,account_id,packet_id) REFERENCES jev_blind_packet_seals(tenant_id,account_id,packet_id),
  FOREIGN KEY(tenant_id,account_id,review_id) REFERENCES jev_blind_label_reviews(tenant_id,account_id,id),
  FOREIGN KEY(tenant_id,account_id,declaration_id) REFERENCES jev_calibration_declarations(tenant_id,account_id,id)
);
CREATE OR REPLACE FUNCTION autoreply.freeze_jev_calibrated_holdout(
  p_tenant text,p_account text,p_source text,p_packet uuid,p_review uuid,p_settings text,p_report text,p_publication jsonb,p_snapshot text)
RETURNS SETOF jev_holdout_lineages LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,autoreply,pg_temp AS $$
DECLARE actor text;a accounts;r evaluation_runs;v jev_blind_label_reviews;d jev_calibration_declarations;
  s jev_blind_packet_seals;x jev_replay_executions;l jev_holdout_lineages;report jsonb;target text;
BEGIN
  SELECT actor_id INTO actor FROM autoreply.authenticate_admin(p_tenant);
  IF actor IS NULL THEN RAISE EXCEPTION 'jev_holdout_denied'; END IF;
  SELECT * INTO a FROM accounts WHERE (tenant_id,id)=(p_tenant,p_account) FOR UPDATE;
  IF NOT FOUND OR NOT a.enabled THEN RAISE EXCEPTION 'jev_holdout_context_invalid'; END IF;
  SELECT * INTO d FROM autoreply.jev_calibration_declaration(p_tenant,p_account,p_source,p_settings,false);
  SELECT * INTO r FROM evaluation_runs WHERE (tenant_id,account_id,id)=(p_tenant,p_account,p_source);
  SELECT * INTO s FROM jev_blind_packet_seals WHERE (tenant_id,account_id,packet_id)=(p_tenant,p_account,p_packet);
  SELECT * INTO x FROM jev_replay_executions WHERE (tenant_id,account_id,id)=(p_tenant,p_account,s.execution_id);
  SELECT * INTO v FROM jev_blind_label_reviews WHERE (tenant_id,account_id,id)=(p_tenant,p_account,p_review);
  IF s.packet_id IS NULL OR s.run_id<>p_source OR x.id IS NULL OR x.split<>'calibration' OR v.id IS NULL OR v.packet_id<>p_packet THEN
    RAISE EXCEPTION 'jev_holdout_source_invalid'; END IF;
  PERFORM 1 FROM autoreply.verify_jev_blind_labels(p_tenant,p_account,p_source,p_packet,s.packet_hash,p_review,v.labels_json);
  IF p_report IS NULL OR octet_length(p_report)>1048576 THEN RAISE EXCEPTION 'jev_holdout_report_invalid'; END IF;
  report:=p_report::jsonb;
  IF jsonb_typeof(report) IS DISTINCT FROM 'object' OR report->>'dataKind' IS DISTINCT FROM 'business'
    OR report->>'status' IS DISTINCT FROM 'recommended_for_frozen_holdout'
    OR report->>'datasetId' IS DISTINCT FROM r.plan_json->>'datasetId'
    OR report->>'experimentSnapshotHash' IS DISTINCT FROM r.snapshot_hash
    OR NOT coalesce(report->>'inputHash' ~ '^[a-f0-9]{64}$',false)
    OR report->'releaseAuthorized' IS DISTINCT FROM 'false'::jsonb
    OR report->'holdoutRequired' IS DISTINCT FROM 'true'::jsonb
    OR jsonb_typeof(report->'recommendedPolicy') IS DISTINCT FROM 'object'
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.settings_json->'candidates') c WHERE c=report->'recommendedPolicy') THEN
    RAISE EXCEPTION 'jev_holdout_report_invalid'; END IF;
  IF report->'sampleCount' IS DISTINCT FROM to_jsonb(jsonb_array_length(x.input_json->'cases'))
    OR report->'independentConversations' IS DISTINCT FROM (SELECT to_jsonb(count(DISTINCT c->>'conversationGroup')) FROM jsonb_array_elements(x.input_json->'cases') c)
    OR (SELECT count(*) FROM jev_replay_assignments b JOIN jev_replay_attempts t
      ON (t.tenant_id,t.account_id,t.assignment_id)=(b.tenant_id,b.account_id,b.id)
      JOIN jev_replay_results result ON (result.tenant_id,result.account_id,result.attempt_id)=(t.tenant_id,t.account_id,t.id)
      WHERE (b.tenant_id,b.account_id,b.execution_id)=(p_tenant,p_account,x.id) AND b.arm='C' AND t.stage='post'
        AND result.result_json->>'outcome'='response')<(d.settings_json->'targets'->>'minimumAutomaticReplies')::integer THEN
    RAISE EXCEPTION 'jev_holdout_report_invalid'; END IF;
  IF jsonb_typeof(p_publication) IS DISTINCT FROM 'object'
    OR (p_publication-ARRAY['configuration','policy']) IS DISTINCT FROM (r.publication_json-ARRAY['configuration','policy'])
    OR ((p_publication->'configuration')-ARRAY['configVersion','decisionPolicyVersion']) IS DISTINCT FROM ((r.publication_json->'configuration')-ARRAY['configVersion','decisionPolicyVersion'])
    OR ((p_publication->'policy')-'version') IS DISTINCT FROM ((report->'recommendedPolicy')-'version')
    OR p_publication->'configuration'->>'configVersion' IS NULL OR p_publication->'policy'->>'version' IS NULL
    OR p_publication->'configuration'->>'configVersion'=r.publication_json->'configuration'->>'configVersion'
    OR p_publication->'policy'->>'version'=r.publication_json->'policy'->>'version'
    OR p_publication->'configuration'->>'decisionPolicyVersion' IS DISTINCT FROM p_publication->'policy'->>'version'
    OR NOT coalesce(p_snapshot ~ '^[a-f0-9]{64}$',false) THEN RAISE EXCEPTION 'jev_holdout_publication_changed'; END IF;
  SELECT * INTO l FROM jev_holdout_lineages WHERE (tenant_id,account_id,source_run_id,review_id)=(p_tenant,p_account,p_source,p_review);
  IF FOUND THEN
    IF l.login_name<>session_user OR l.actor_id<>actor OR l.packet_id<>p_packet OR l.declaration_id<>d.id
      OR l.settings_hash<>d.settings_hash OR l.labels_hash<>v.labels_hash OR l.report_canonical<>p_report
      OR l.report_hash<>encode(sha256(convert_to(p_report,'UTF8')),'hex') OR l.input_hash<>report->>'inputHash'
      OR l.source_snapshot_hash<>r.snapshot_hash OR l.target_snapshot_hash<>p_snapshot
      OR NOT EXISTS(SELECT 1 FROM evaluation_runs t WHERE (t.tenant_id,t.account_id,t.id)=(p_tenant,p_account,l.target_run_id)
        AND t.snapshot_hash=p_snapshot AND t.publication_json=p_publication AND t.plan_json=r.plan_json
        AND t.created_at>=l.created_at AND t.expires_at>clock_timestamp()) THEN
      RAISE EXCEPTION 'jev_holdout_lineage_changed'; END IF;
    RETURN NEXT l;RETURN;
  END IF;
  -- Beginning an execution is already an exposure risk, even if it made zero
  -- model calls. Check across runs and splits on the same account/dataset.
  IF EXISTS(SELECT 1 FROM jev_replay_executions e,
      jsonb_array_elements(e.plan_json->'assignments') used,
      jsonb_array_elements(r.plan_json->'assignments') planned
    WHERE (e.tenant_id,e.account_id)=(p_tenant,p_account) AND e.plan_json->>'datasetId'=r.plan_json->>'datasetId'
      AND used->>'split'=e.split AND planned->>'split'='holdout'
      AND (used->>'conversationGroup'=planned->>'conversationGroup' OR used->>'caseId'=planned->>'caseId' OR used->>'inputHash'=planned->>'inputHash')) THEN
    RAISE EXCEPTION 'jev_holdout_previously_exposed'; END IF;
  target:=gen_random_uuid()::text;
  -- Let the target freeze precede the lineage clock so a retry never relies on
  -- caller clocks. Both rows commit together under the original account lock.
  INSERT INTO evaluation_runs(tenant_id,account_id,id,snapshot_hash,publication_json,plan_json,created_by)
    VALUES(p_tenant,p_account,target,p_snapshot,p_publication,r.plan_json,actor);
  RETURN QUERY INSERT INTO jev_holdout_lineages(tenant_id,account_id,id,source_run_id,target_run_id,packet_id,review_id,declaration_id,
    settings_hash,labels_hash,report_canonical,report_json,report_hash,input_hash,source_snapshot_hash,target_snapshot_hash,actor_id,login_name,created_at)
    SELECT p_tenant,p_account,gen_random_uuid(),p_source,target,p_packet,p_review,d.id,d.settings_hash,v.labels_hash,p_report,report,
      encode(sha256(convert_to(p_report,'UTF8')),'hex'),report->>'inputHash',r.snapshot_hash,p_snapshot,actor,session_user,t.created_at
      FROM evaluation_runs t WHERE (t.tenant_id,t.account_id,t.id)=(p_tenant,p_account,target) RETURNING *;
END $$;
CREATE OR REPLACE FUNCTION autoreply.jev_holdout_execution_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,autoreply,pg_temp AS $$
DECLARE l jev_holdout_lineages;r evaluation_runs;v jev_blind_label_reviews;s jev_blind_packet_seals;
BEGIN
  -- Active lineage means the source packet's current independent revision.
  -- A later correction prevents executing the obsolete target freeze.
  FOR l IN SELECT h.* FROM jev_holdout_lineages h JOIN evaluation_runs source
      ON (source.tenant_id,source.account_id,source.id)=(h.tenant_id,h.account_id,h.source_run_id)
    WHERE (h.tenant_id,h.account_id)=(NEW.tenant_id,NEW.account_id)
      AND (h.target_run_id=NEW.run_id OR (source.plan_json->>'datasetId'=NEW.plan_json->>'datasetId' AND EXISTS(
        SELECT 1 FROM jsonb_array_elements(source.plan_json->'assignments') p,
          jsonb_array_elements(NEW.plan_json->'assignments') n
        WHERE p->>'split'='holdout' AND n->>'split'=NEW.split
          AND (p->>'conversationGroup'=n->>'conversationGroup' OR p->>'caseId'=n->>'caseId' OR p->>'inputHash'=n->>'inputHash')))) LOOP
    SELECT * INTO v FROM jev_blind_label_reviews WHERE (tenant_id,account_id,id)=(l.tenant_id,l.account_id,l.review_id);
    IF l.target_run_id=NEW.run_id THEN
      IF NEW.split<>'holdout' THEN RAISE EXCEPTION 'jev_holdout_target_split_invalid'; END IF;
      SELECT * INTO s FROM jev_blind_packet_seals WHERE (tenant_id,account_id,packet_id)=(l.tenant_id,l.account_id,l.packet_id);
      PERFORM 1 FROM autoreply.verify_jev_blind_labels(l.tenant_id,l.account_id,l.source_run_id,l.packet_id,s.packet_hash,l.review_id,v.labels_json);
      SELECT * INTO r FROM evaluation_runs WHERE (tenant_id,account_id,id)=(NEW.tenant_id,NEW.account_id,l.source_run_id);
      PERFORM 1 FROM autoreply.jev_calibration_declaration(l.tenant_id,l.account_id,l.source_run_id,
        (SELECT settings_canonical FROM jev_calibration_declarations WHERE (tenant_id,account_id,run_id)=(l.tenant_id,l.account_id,l.source_run_id)),false);
      IF l.target_snapshot_hash<>NEW.snapshot_hash OR NEW.plan_json<>r.plan_json THEN RAISE EXCEPTION 'jev_holdout_lineage_changed'; END IF;
    ELSIF v.revision=(SELECT max(revision) FROM jev_blind_label_reviews WHERE (tenant_id,account_id,packet_id)=(v.tenant_id,v.account_id,v.packet_id)) THEN
      RAISE EXCEPTION 'jev_holdout_reserved_for_target';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION autoreply.freeze_jev_calibrated_holdout(text,text,text,uuid,uuid,text,text,jsonb,text),autoreply.jev_holdout_execution_guard() FROM PUBLIC;
-- Existing executions must also stop paying for new requests after an
-- independent reviewer revision/disablement. Finishing an already-reserved
-- receipt remains permitted; results do not carry this new-call trigger.
CREATE OR REPLACE FUNCTION autoreply.jev_holdout_call_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,autoreply,pg_temp AS $$
DECLARE e jev_replay_executions;l jev_holdout_lineages;v jev_blind_label_reviews;s jev_blind_packet_seals;
BEGIN
  IF TG_TABLE_NAME='jev_replay_assignments' THEN
    SELECT * INTO e FROM jev_replay_executions WHERE (tenant_id,account_id,id)=(NEW.tenant_id,NEW.account_id,NEW.execution_id);
  ELSE
    SELECT x.* INTO e FROM jev_replay_assignments b JOIN jev_replay_executions x
      ON (x.tenant_id,x.account_id,x.id)=(b.tenant_id,b.account_id,b.execution_id)
      WHERE (b.tenant_id,b.account_id,b.id)=(NEW.tenant_id,NEW.account_id,NEW.assignment_id);
  END IF;
  SELECT * INTO l FROM jev_holdout_lineages WHERE (tenant_id,account_id,target_run_id)=(e.tenant_id,e.account_id,e.run_id);
  IF FOUND THEN
    SELECT * INTO v FROM jev_blind_label_reviews WHERE (tenant_id,account_id,id)=(l.tenant_id,l.account_id,l.review_id);
    SELECT * INTO s FROM jev_blind_packet_seals WHERE (tenant_id,account_id,packet_id)=(l.tenant_id,l.account_id,l.packet_id);
    PERFORM 1 FROM autoreply.verify_jev_blind_labels(l.tenant_id,l.account_id,l.source_run_id,l.packet_id,s.packet_hash,l.review_id,v.labels_json);
    PERFORM 1 FROM autoreply.jev_calibration_declaration(l.tenant_id,l.account_id,l.source_run_id,
      (SELECT settings_canonical FROM jev_calibration_declarations WHERE (tenant_id,account_id,run_id)=(l.tenant_id,l.account_id,l.source_run_id)),false);
    IF e.split<>'holdout' OR e.snapshot_hash<>l.target_snapshot_hash THEN RAISE EXCEPTION 'jev_holdout_lineage_changed'; END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION autoreply.jev_holdout_call_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS jev_holdout_call_guard ON jev_replay_assignments;
CREATE TRIGGER jev_holdout_call_guard BEFORE INSERT ON jev_replay_assignments
  FOR EACH ROW EXECUTE FUNCTION autoreply.jev_holdout_call_guard();
DROP TRIGGER IF EXISTS jev_holdout_call_guard ON jev_replay_attempts;
CREATE TRIGGER jev_holdout_call_guard BEFORE INSERT ON jev_replay_attempts
  FOR EACH ROW EXECUTE FUNCTION autoreply.jev_holdout_call_guard();
GRANT EXECUTE ON FUNCTION autoreply.freeze_jev_calibrated_holdout(text,text,text,uuid,uuid,text,text,jsonb,text) TO autoreply_admin;
ALTER TABLE jev_holdout_lineages ENABLE ROW LEVEL SECURITY;
ALTER TABLE jev_holdout_lineages FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename='jev_holdout_lineages' AND policyname='tenant_scope') THEN
    CREATE POLICY tenant_scope ON jev_holdout_lineages USING(tenant_id=current_setting('app.tenant_id',true)) WITH CHECK(false);
    CREATE POLICY admin_login_scope ON jev_holdout_lineages AS RESTRICTIVE TO autoreply_admin
      USING(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id))) WITH CHECK(false);
  END IF;
END $$;
DROP TRIGGER IF EXISTS jev_holdout_lineages_immutable ON jev_holdout_lineages;
CREATE TRIGGER jev_holdout_lineages_immutable BEFORE UPDATE OR DELETE ON jev_holdout_lineages
  FOR EACH ROW EXECUTE FUNCTION autoreply.jev_replay_immutable();
DROP TRIGGER IF EXISTS jev_holdout_execution_guard ON jev_replay_executions;
CREATE TRIGGER jev_holdout_execution_guard BEFORE INSERT ON jev_replay_executions
  FOR EACH ROW EXECUTE FUNCTION autoreply.jev_holdout_execution_guard();
REVOKE ALL ON jev_holdout_lineages FROM PUBLIC,autoreply_app,autoreply_learning_worker,autoreply_admin,autoreply_jev_reviewer;
GRANT SELECT ON jev_holdout_lineages TO autoreply_admin;
