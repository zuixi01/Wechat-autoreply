SET search_path=autoreply,public;
CREATE TABLE IF NOT EXISTS model_call_limits (
  tenant_id text NOT NULL,account_id text NOT NULL,
  daily_attempt_limit integer NOT NULL CHECK(daily_attempt_limit BETWEEN 0 AND 100000),
  revision bigint NOT NULL CHECK(revision>0),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,account_id),
  FOREIGN KEY(tenant_id,account_id) REFERENCES accounts(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS model_call_attempts (
  tenant_id text NOT NULL,account_id text NOT NULL,id text NOT NULL,agent_id text NOT NULL,task_id text NOT NULL,
  task_hash text NOT NULL CHECK(task_hash ~ '^[a-f0-9]{64}$'),
  provider text NOT NULL CHECK(provider IN ('jev','text')),stage text NOT NULL CHECK(stage IN ('pre','text','post')),
  attempt_number integer NOT NULL CHECK(attempt_number>0),
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),requested_model text NOT NULL,
  question_hash text CHECK(question_hash ~ '^[a-f0-9]{64}$'),
  config_version text NOT NULL,policy_version text NOT NULL,question_set_version text NOT NULL,
  knowledge_version text NOT NULL,limit_revision bigint NOT NULL,
  usage_day date NOT NULL DEFAULT (clock_timestamp() AT TIME ZONE 'UTC')::date,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,account_id,id),
  UNIQUE(tenant_id,account_id,task_id,stage,attempt_number),
  FOREIGN KEY(tenant_id,account_id,task_id) REFERENCES generation_tasks(tenant_id,account_id,task_id),
  FOREIGN KEY(tenant_id,agent_id,account_id) REFERENCES agents(tenant_id,id,account_id),
  CHECK((stage='text')=(provider='text')),
  CHECK((provider='jev')=(question_hash IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS model_call_daily ON model_call_attempts(tenant_id,account_id,usage_day);
CREATE TABLE IF NOT EXISTS model_call_results (
  tenant_id text NOT NULL,account_id text NOT NULL,attempt_id text NOT NULL,
  result_hash text NOT NULL CHECK(result_hash ~ '^[a-f0-9]{64}$'),result_json jsonb NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,account_id,attempt_id),
  FOREIGN KEY(tenant_id,account_id,attempt_id) REFERENCES model_call_attempts(tenant_id,account_id,id)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['model_call_limits','model_call_attempts','model_call_results'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename=t AND policyname='tenant_scope') THEN
      EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=current_setting(''app.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''app.tenant_id'',true))',t);
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename=t AND policyname='admin_login_scope') THEN
      EXECUTE format('CREATE POLICY admin_login_scope ON %I AS RESTRICTIVE TO autoreply_admin USING(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id))) WITH CHECK(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id)))',t);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON model_call_limits,model_call_attempts,model_call_results FROM PUBLIC,autoreply_app,autoreply_admin;
GRANT SELECT ON model_call_limits TO autoreply_app;
GRANT SELECT,INSERT,UPDATE ON model_call_limits TO autoreply_admin;
GRANT SELECT,INSERT ON model_call_attempts,model_call_results TO autoreply_app;
GRANT SELECT ON model_call_attempts,model_call_results TO autoreply_admin;

-- Every worker and direct service INSERT takes the same account lock. A failed,
-- cancelled or crashed reservation is never refunded or silently reused.
CREATE OR REPLACE FUNCTION autoreply.guard_model_call_reservation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,autoreply AS $$
DECLARE a accounts; l model_call_limits; g generation_tasks; BEGIN
  SELECT * INTO a FROM accounts WHERE (tenant_id,id)=(NEW.tenant_id,NEW.account_id) FOR UPDATE;
  SELECT * INTO l FROM model_call_limits WHERE (tenant_id,account_id)=(NEW.tenant_id,NEW.account_id);
  SELECT * INTO g FROM generation_tasks WHERE (tenant_id,account_id,task_id)=(NEW.tenant_id,NEW.account_id,NEW.task_id);
  IF a.id IS NULL OR NOT a.enabled OR a.paused OR l.account_id IS NULL OR g.task_id IS NULL OR g.status<>'running'
    OR g.agent_id<>NEW.agent_id THEN RAISE EXCEPTION 'model_call_not_authorized'; END IF;
  NEW.usage_day := (clock_timestamp() AT TIME ZONE 'UTC')::date;
  NEW.started_at := clock_timestamp();
  IF NEW.limit_revision<>l.revision OR
    (SELECT count(*) FROM model_call_attempts WHERE tenant_id=NEW.tenant_id AND account_id=NEW.account_id AND usage_day=NEW.usage_day)>=l.daily_attempt_limit
    THEN RAISE EXCEPTION 'model_call_limit_reached'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION autoreply.guard_model_call_reservation() FROM PUBLIC;
DROP TRIGGER IF EXISTS model_call_reservation_guard ON model_call_attempts;
CREATE TRIGGER model_call_reservation_guard BEFORE INSERT ON model_call_attempts FOR EACH ROW EXECUTE FUNCTION autoreply.guard_model_call_reservation();

CREATE OR REPLACE VIEW decision_runs WITH(security_invoker=true) AS
  SELECT a.*,r.completed_at,r.result_json FROM model_call_attempts a LEFT JOIN model_call_results r
    ON (r.tenant_id,r.account_id,r.attempt_id)=(a.tenant_id,a.account_id,a.id) WHERE a.provider='jev';
CREATE OR REPLACE VIEW draft_reviews WITH(security_invoker=true) AS
  SELECT tenant_id,account_id,task_id,agent_id,updated_at,result_json->'review' AS review_json
    FROM generation_tasks WHERE status='completed' AND result_json->'review' IS NOT NULL;
GRANT SELECT ON decision_runs,draft_reviews TO autoreply_app,autoreply_admin;
