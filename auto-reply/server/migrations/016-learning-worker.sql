SET search_path=autoreply,public;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='autoreply_learning_worker') THEN
    CREATE ROLE autoreply_learning_worker NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='autoreply_learning_worker' AND (rolsuper OR rolbypassrls OR rolcanlogin)) THEN
    RAISE EXCEPTION 'learning_worker_group_role_invalid';
  END IF;
END $$;
GRANT autoreply_app TO autoreply_learning_worker;
CREATE TABLE IF NOT EXISTS learning_worker_bindings (
  id uuid PRIMARY KEY,login_name name NOT NULL,tenant_id text NOT NULL,account_id text NOT NULL,
  employee_id text NOT NULL,agent_id text NOT NULL,agent_token_hash text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(login_name,tenant_id,account_id,agent_id),
  FOREIGN KEY(tenant_id,account_id,employee_id) REFERENCES accounts(tenant_id,id,employee_id),
  FOREIGN KEY(tenant_id,agent_id,account_id) REFERENCES agents(tenant_id,id,account_id)
);
ALTER TABLE learning_worker_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_worker_bindings FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename='learning_worker_bindings' AND policyname='admin_worker_binding') THEN
    CREATE POLICY admin_worker_binding ON learning_worker_bindings TO autoreply_admin
      USING (tenant_id=current_setting('app.tenant_id',true) AND EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id)))
      WITH CHECK (tenant_id=current_setting('app.tenant_id',true) AND EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id)));
  END IF;
END $$;
REVOKE ALL ON learning_worker_bindings FROM PUBLIC,autoreply_app,autoreply_learning_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON learning_worker_bindings TO autoreply_admin;

-- A migration/admin identity grants a particular login an explicit account/device binding.
-- The fingerprint revokes that binding on credential rotation without retaining any device secret.
CREATE OR REPLACE FUNCTION autoreply.authenticate_learning_worker(p_reference uuid,p_lock boolean DEFAULT false)
RETURNS TABLE(tenant_id text,employee_id text,account_id text,agent_id text,platform text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,autoreply,pg_temp AS $$
DECLARE binding autoreply.learning_worker_bindings%ROWTYPE;
BEGIN
  IF NOT pg_has_role(session_user,'autoreply_learning_worker','USAGE') THEN RETURN; END IF;
  SELECT b.* INTO binding FROM autoreply.learning_worker_bindings b
    WHERE b.id=p_reference AND b.login_name=session_user AND b.enabled;
  IF NOT FOUND THEN RETURN; END IF;
  IF p_lock THEN
    -- The same account-first order as device mutation and revocation.
    PERFORM 1 FROM autoreply.accounts a WHERE a.tenant_id=binding.tenant_id AND a.id=binding.account_id FOR UPDATE;
    PERFORM 1 FROM autoreply.agents g WHERE g.tenant_id=binding.tenant_id AND g.id=binding.agent_id FOR SHARE;
    PERFORM 1 FROM autoreply.employees e WHERE e.tenant_id=binding.tenant_id AND e.id=binding.employee_id FOR SHARE;
    PERFORM 1 FROM autoreply.learning_worker_bindings b WHERE b.id=p_reference FOR SHARE;
  END IF;
  RETURN QUERY SELECT a.tenant_id,a.employee_id,a.id,g.id,a.platform
    FROM autoreply.learning_worker_bindings b
    JOIN autoreply.accounts a ON (a.tenant_id,a.id,a.employee_id)=(b.tenant_id,b.account_id,b.employee_id)
    JOIN autoreply.agents g ON (g.tenant_id,g.id,g.account_id,g.employee_id)=(b.tenant_id,b.agent_id,b.account_id,b.employee_id)
    JOIN autoreply.employees e ON (e.tenant_id,e.id)=(b.tenant_id,b.employee_id)
    WHERE b.id=p_reference AND b.login_name=session_user AND b.enabled AND a.enabled AND e.enabled
      AND g.revoked_at IS NULL AND g.token_hash=b.agent_token_hash
      AND (b.tenant_id,b.account_id,b.employee_id,b.agent_id,b.agent_token_hash)
        =(binding.tenant_id,binding.account_id,binding.employee_id,binding.agent_id,binding.agent_token_hash);
END $$;
REVOKE ALL ON FUNCTION autoreply.authenticate_learning_worker(uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION autoreply.authenticate_learning_worker(uuid,boolean) TO autoreply_learning_worker;

CREATE OR REPLACE FUNCTION autoreply.learning_worker_references()
RETURNS TABLE(id uuid) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,autoreply,pg_temp AS $$
  SELECT b.id FROM autoreply.learning_worker_bindings b
    CROSS JOIN LATERAL autoreply.authenticate_learning_worker(b.id,false) verified
    WHERE b.login_name=session_user AND b.enabled ORDER BY b.id;
$$;
REVOKE ALL ON FUNCTION autoreply.learning_worker_references() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION autoreply.learning_worker_references() TO autoreply_learning_worker;
