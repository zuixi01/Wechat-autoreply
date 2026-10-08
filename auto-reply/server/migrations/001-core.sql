-- Apply using the migration role. The service role must not be a superuser/BYPASSRLS.
CREATE SCHEMA IF NOT EXISTS autoreply;
SET search_path=autoreply,public;
CREATE TABLE IF NOT EXISTS tenants (id text PRIMARY KEY, name text NOT NULL);
CREATE TABLE IF NOT EXISTS employees (
  tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL,
  role text NOT NULL CHECK(role IN ('admin','employee')), enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS accounts (
  tenant_id text NOT NULL, id text NOT NULL, employee_id text NOT NULL,
  platform text NOT NULL CHECK(platform IN ('wechat','wework')),
  enabled boolean NOT NULL DEFAULT true, paused boolean NOT NULL DEFAULT true,
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,id,employee_id),
  FOREIGN KEY(tenant_id,employee_id) REFERENCES employees(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS enrollment_codes (
  code_hash text PRIMARY KEY, tenant_id text NOT NULL, account_id text NOT NULL,
  employee_id text NOT NULL, expires_at timestamptz NOT NULL, used_at timestamptz,
  FOREIGN KEY(tenant_id,account_id,employee_id) REFERENCES accounts(tenant_id,id,employee_id)
);
CREATE TABLE IF NOT EXISTS agents (
  tenant_id text NOT NULL, id text NOT NULL, account_id text NOT NULL, employee_id text NOT NULL,
  token_hash text NOT NULL UNIQUE, revoked_at timestamptz, registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,id,account_id),
  FOREIGN KEY(tenant_id,account_id,employee_id) REFERENCES accounts(tenant_id,id,employee_id)
);
CREATE TABLE IF NOT EXISTS account_leases (
  tenant_id text NOT NULL, account_id text NOT NULL, agent_id text NOT NULL,
  login_epoch bigint NOT NULL CHECK(login_epoch>=0), client_instance_id text NOT NULL,
  version bigint NOT NULL CHECK(version>0), expires_at timestamptz NOT NULL,
  PRIMARY KEY(tenant_id,account_id),
  FOREIGN KEY(tenant_id,agent_id,account_id) REFERENCES agents(tenant_id,id,account_id)
);
CREATE TABLE IF NOT EXISTS execution_permits (
  tenant_id text NOT NULL, account_id text NOT NULL, id text NOT NULL,
  agent_id text NOT NULL, lease_version bigint NOT NULL, task_id text NOT NULL,
  draft_hash text NOT NULL, status text NOT NULL CHECK(status IN ('issued','confirmed','not_sent','unknown')),
  evidence text, issued_at timestamptz NOT NULL DEFAULT clock_timestamp(), settled_at timestamptz,
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,account_id,task_id),
  FOREIGN KEY(tenant_id,agent_id,account_id) REFERENCES agents(tenant_id,id,account_id)
);
CREATE INDEX IF NOT EXISTS unresolved_permits_account ON execution_permits(tenant_id,account_id)
  WHERE status IN ('issued','unknown');
CREATE TABLE IF NOT EXISTS audit_events (
  tenant_id text NOT NULL, id text NOT NULL, actor_id text NOT NULL,
  kind text NOT NULL, account_id text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id) REFERENCES tenants(id)
);
-- Transaction-local trusted authentication scope, never set from the request body's tenantId.
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['employees','accounts','agents','account_leases','execution_permits','audit_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename=table_name AND policyname='tenant_scope') THEN
      EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id=current_setting(''app.tenant_id'',true)) WITH CHECK (tenant_id=current_setting(''app.tenant_id'',true))',table_name);
    END IF;
  END LOOP;
END $$;
-- enrollment_codes is only accessible by the privileged registration transaction.
-- Revoke direct access from the normal service role; authentication uses a separate credential role.

CREATE OR REPLACE FUNCTION autoreply.authenticate_device(p_hash text)
RETURNS TABLE(tenant_id text, employee_id text, account_id text, agent_id text, platform text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,autoreply AS $$
  SELECT a.tenant_id,a.employee_id,a.account_id,a.id,c.platform
  FROM agents a JOIN accounts c ON (c.tenant_id,c.id)=(a.tenant_id,a.account_id)
  JOIN employees e ON (e.tenant_id,e.id)=(a.tenant_id,a.employee_id)
  WHERE a.token_hash=p_hash AND a.revoked_at IS NULL AND c.enabled AND e.enabled
$$;
REVOKE ALL ON FUNCTION autoreply.authenticate_device(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION autoreply.redeem_enrollment(p_code_hash text,p_agent_id text,p_token_hash text)
RETURNS TABLE(tenant_id text, employee_id text, account_id text, agent_id text, platform text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,autoreply AS $$
DECLARE invitation enrollment_codes; account accounts; BEGIN
  SELECT * INTO invitation FROM enrollment_codes WHERE code_hash=p_code_hash FOR UPDATE;
  IF NOT FOUND OR invitation.used_at IS NOT NULL OR invitation.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'registration_rejected';
  END IF;
  SELECT * INTO account FROM accounts WHERE (accounts.tenant_id,accounts.id)=(invitation.tenant_id,invitation.account_id) FOR UPDATE;
  IF NOT account.enabled OR NOT EXISTS(SELECT 1 FROM employees WHERE (employees.tenant_id,employees.id)=(invitation.tenant_id,invitation.employee_id) AND enabled) THEN
    RAISE EXCEPTION 'registration_rejected';
  END IF;
  INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash)
    VALUES(invitation.tenant_id,p_agent_id,invitation.account_id,invitation.employee_id,p_token_hash);
  UPDATE enrollment_codes SET used_at=clock_timestamp() WHERE code_hash=p_code_hash;
  RETURN QUERY SELECT invitation.tenant_id,invitation.employee_id,invitation.account_id,p_agent_id,account.platform;
END $$;
REVOKE ALL ON FUNCTION autoreply.redeem_enrollment(text,text,text) FROM PUBLIC;

DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='autoreply_app') THEN
    CREATE ROLE autoreply_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA autoreply TO autoreply_app;
GRANT SELECT,INSERT,UPDATE ON employees,accounts,agents,account_leases,execution_permits,audit_events TO autoreply_app;
GRANT EXECUTE ON FUNCTION autoreply.authenticate_device(text) TO autoreply_app;
GRANT EXECUTE ON FUNCTION autoreply.redeem_enrollment(text,text,text) TO autoreply_app;
-- These two SECURITY DEFINER functions must be owned by the dedicated migration/credential
-- role with BYPASSRLS. Never use that role's connection string for ordinary API transactions.
