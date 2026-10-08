SET search_path=autoreply,public;
CREATE INDEX IF NOT EXISTS generation_running_deadline ON generation_tasks(expires_at)
  WHERE status='running';

-- Database-wide logical generation admission: 10 tasks total, 2 per account.
-- No lock is held during provider HTTP. A deadline releases logical capacity,
-- not a claim that a remote provider physically stopped or did not bill.
CREATE OR REPLACE FUNCTION autoreply.guard_generation_capacity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path=pg_catalog,autoreply,pg_temp SET row_security=off AS $$
DECLARE at_time timestamptz; total integer; local_total integer; BEGIN
  IF TG_OP='UPDATE' THEN
    IF (NEW.tenant_id,NEW.account_id,NEW.task_id,NEW.agent_id,NEW.request_hash,NEW.task_json,NEW.expires_at,NEW.started_at)
      IS DISTINCT FROM (OLD.tenant_id,OLD.account_id,OLD.task_id,OLD.agent_id,OLD.request_hash,OLD.task_json,OLD.expires_at,OLD.started_at)
      THEN RAISE EXCEPTION 'generation_task_immutable'; END IF;
    IF NEW.status='running' AND OLD.status<>'running' THEN
      RAISE EXCEPTION 'generation_task_not_restartable';
    END IF;
    IF NEW.status='completed' AND OLD.status='running' AND OLD.expires_at<=clock_timestamp() THEN
      RAISE EXCEPTION 'generation_task_expired';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status<>'running' THEN RETURN NEW; END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'generation_isolation_unsupported';
  END IF;
  IF NEW.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'generation_task_expired'; END IF;
  -- A volatile query after this transaction-level lock observes earlier commits
  -- under READ COMMITTED. Only this trigger can use the privileged cross-tenant count.
  PERFORM pg_advisory_xact_lock(hashtextextended('autoreply-generation-capacity:v1',0));
  at_time := clock_timestamp();
  IF NEW.expires_at<=at_time THEN RAISE EXCEPTION 'generation_task_expired'; END IF;
  SELECT count(*),count(*) FILTER(WHERE tenant_id=NEW.tenant_id AND account_id=NEW.account_id)
    INTO total,local_total FROM generation_tasks WHERE status='running' AND expires_at>at_time;
  IF total>=10 OR local_total>=2 THEN RAISE EXCEPTION 'generation_cluster_overloaded'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION autoreply.guard_generation_capacity() FROM PUBLIC,autoreply_app,autoreply_admin;
DROP TRIGGER IF EXISTS generation_capacity_guard ON generation_tasks;
CREATE TRIGGER generation_capacity_guard BEFORE INSERT OR UPDATE ON generation_tasks
  FOR EACH ROW EXECUTE FUNCTION autoreply.guard_generation_capacity();

-- A crashed/late worker cannot use an expired row to initiate another model request.
CREATE OR REPLACE FUNCTION autoreply.guard_model_call_reservation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,autoreply AS $$
DECLARE a accounts; l model_call_limits; g generation_tasks; BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'model_call_isolation_unsupported';
  END IF;
  SELECT * INTO a FROM accounts WHERE (tenant_id,id)=(NEW.tenant_id,NEW.account_id) FOR UPDATE;
  SELECT * INTO l FROM model_call_limits WHERE (tenant_id,account_id)=(NEW.tenant_id,NEW.account_id);
  SELECT * INTO g FROM generation_tasks WHERE (tenant_id,account_id,task_id)=(NEW.tenant_id,NEW.account_id,NEW.task_id);
  IF a.id IS NULL OR NOT a.enabled OR a.paused OR l.account_id IS NULL OR g.task_id IS NULL OR g.status<>'running'
    OR g.agent_id<>NEW.agent_id OR g.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'model_call_not_authorized'; END IF;
  NEW.usage_day := (clock_timestamp() AT TIME ZONE 'UTC')::date;
  NEW.started_at := clock_timestamp();
  IF NEW.limit_revision<>l.revision OR
    (SELECT count(*) FROM model_call_attempts WHERE tenant_id=NEW.tenant_id AND account_id=NEW.account_id AND usage_day=NEW.usage_day)>=l.daily_attempt_limit
    THEN RAISE EXCEPTION 'model_call_limit_reached'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION autoreply.guard_model_call_reservation() FROM PUBLIC;
