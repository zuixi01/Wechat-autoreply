SET search_path=autoreply,public;
-- Permanent, append-only tombstones. A lost response must not allow a late
-- issuance to create authority after the local journal has been resolved.
CREATE TABLE IF NOT EXISTS execution_request_seals (
  tenant_id text NOT NULL,account_id text NOT NULL,id text NOT NULL,agent_id text NOT NULL,
  task_id text NOT NULL,execution_id text NOT NULL,request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  seal_hash text NOT NULL CHECK(seal_hash ~ '^[a-f0-9]{64}$'),
  seal_json jsonb NOT NULL CHECK(jsonb_typeof(seal_json)='object'),
  sealed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,account_id,id),UNIQUE(tenant_id,account_id,task_id),
  UNIQUE(tenant_id,account_id,id,agent_id,seal_hash,execution_id),
  FOREIGN KEY(tenant_id,agent_id,account_id) REFERENCES agents(tenant_id,id,account_id)
);
CREATE TABLE IF NOT EXISTS execution_request_seal_applications (
  tenant_id text NOT NULL,account_id text NOT NULL,seal_id text NOT NULL,agent_id text NOT NULL,
  seal_hash text NOT NULL CHECK(seal_hash ~ '^[a-f0-9]{64}$'),execution_id text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,account_id,seal_id),
  FOREIGN KEY(tenant_id,account_id,seal_id,agent_id,seal_hash,execution_id)
    REFERENCES execution_request_seals(tenant_id,account_id,id,agent_id,seal_hash,execution_id),
  FOREIGN KEY(tenant_id,agent_id,account_id) REFERENCES agents(tenant_id,id,account_id)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['execution_request_seals','execution_request_seal_applications'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename=t AND policyname='tenant_scope') THEN
      EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=current_setting(''app.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''app.tenant_id'',true))',t);
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename=t AND policyname='admin_login_scope') THEN
      EXECUTE format('CREATE POLICY admin_login_scope ON %I AS RESTRICTIVE TO autoreply_admin USING(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id))) WITH CHECK(false)',t);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON execution_request_seals,execution_request_seal_applications FROM PUBLIC,autoreply_app,autoreply_admin;
GRANT SELECT,INSERT ON execution_request_seals,execution_request_seal_applications TO autoreply_app;
GRANT SELECT ON execution_request_seals,execution_request_seal_applications TO autoreply_admin;

-- Defense in depth: both directions take the SAME account lock. Service SQL
-- cannot create a permit for a sealed task, even after explicit resume, a new
-- lease, another Agent, another draft or a switch from automatic to human.
CREATE OR REPLACE FUNCTION autoreply.guard_request_seal() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,autoreply AS $$
DECLARE a accounts; BEGIN
  SELECT * INTO a FROM accounts WHERE (tenant_id,id)=(NEW.tenant_id,NEW.account_id) FOR UPDATE;
  IF TG_TABLE_NAME='execution_request_seals' THEN
    IF NOT a.paused OR EXISTS(SELECT 1 FROM account_leases WHERE tenant_id=NEW.tenant_id AND account_id=NEW.account_id AND expires_at>clock_timestamp()) THEN
      RAISE EXCEPTION 'request_seal_not_ready';
    END IF;
    IF EXISTS(SELECT 1 FROM execution_permits WHERE tenant_id=NEW.tenant_id AND account_id=NEW.account_id AND task_id=NEW.task_id) THEN
      RAISE EXCEPTION 'request_seal_existing_permit';
    END IF;
  ELSIF EXISTS(SELECT 1 FROM execution_request_seals WHERE tenant_id=NEW.tenant_id AND account_id=NEW.account_id AND task_id=NEW.task_id) THEN
    RAISE EXCEPTION 'execution_request_sealed';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION autoreply.guard_request_seal() FROM PUBLIC;
DROP TRIGGER IF EXISTS request_seal_guard ON execution_request_seals;
CREATE TRIGGER request_seal_guard BEFORE INSERT ON execution_request_seals FOR EACH ROW EXECUTE FUNCTION autoreply.guard_request_seal();
DROP TRIGGER IF EXISTS execution_request_seal_guard ON execution_permits;
CREATE TRIGGER execution_request_seal_guard BEFORE INSERT OR UPDATE OF tenant_id,account_id,task_id ON execution_permits FOR EACH ROW EXECUTE FUNCTION autoreply.guard_request_seal();
