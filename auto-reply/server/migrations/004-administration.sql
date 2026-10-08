SET search_path=autoreply,public;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='autoreply_admin') THEN
    CREATE ROLE autoreply_admin NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='autoreply_admin' AND (rolsuper OR rolbypassrls OR rolcanlogin)) THEN
    RAISE EXCEPTION 'administrator_group_role_invalid';
  END IF;
END $$;
-- A migration operator provisions this binding. CLI arguments cannot create an admin.
CREATE TABLE IF NOT EXISTS admin_database_principals (
  login_name name NOT NULL, tenant_id text NOT NULL, employee_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY(login_name,tenant_id),
  FOREIGN KEY(tenant_id,employee_id) REFERENCES employees(tenant_id,id)
);
ALTER TABLE admin_database_principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_database_principals FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename='admin_database_principals' AND policyname='own_login') THEN
    CREATE POLICY own_login ON admin_database_principals
      USING(login_name=session_user) WITH CHECK(false);
  END IF;
END $$;
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS details_json jsonb;
CREATE OR REPLACE FUNCTION autoreply.authenticate_admin(p_tenant text)
RETURNS TABLE(tenant_id text,actor_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,autoreply,pg_temp AS $$
BEGIN
  IF NOT pg_has_role(session_user,'autoreply_admin','USAGE') OR
     EXISTS(SELECT 1 FROM pg_roles WHERE (rolsuper OR rolbypassrls)
       AND pg_has_role(session_user,oid,'MEMBER')) THEN
    RETURN;
  END IF;
  -- Revoke/disable must wait for the authorized operation to commit or roll back.
  RETURN QUERY SELECT p.tenant_id,p.employee_id
    FROM autoreply.admin_database_principals p
    JOIN autoreply.employees e ON (e.tenant_id,e.id)=(p.tenant_id,p.employee_id)
    WHERE p.login_name=session_user AND p.tenant_id=p_tenant AND p.enabled
      AND e.enabled AND e.role='admin' FOR SHARE OF p,e;
END $$;
REVOKE ALL ON FUNCTION autoreply.authenticate_admin(text) FROM PUBLIC;
GRANT USAGE ON SCHEMA autoreply TO autoreply_admin;
GRANT EXECUTE ON FUNCTION autoreply.authenticate_admin(text) TO autoreply_admin;
GRANT SELECT ON admin_database_principals,execution_permits,reviewed_replies,generation_tasks TO autoreply_admin;
GRANT SELECT,INSERT,UPDATE ON employees,accounts,published_configurations TO autoreply_admin;
GRANT SELECT,UPDATE ON agents,account_leases TO autoreply_admin;
GRANT SELECT,INSERT,UPDATE ON enrollment_codes TO autoreply_admin;
GRANT SELECT,INSERT ON audit_events,generation_publications TO autoreply_admin;
-- Normal service has no direct enrollment access; administrators remain scoped.
ALTER TABLE enrollment_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrollment_codes FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename='enrollment_codes' AND policyname='tenant_scope') THEN
    CREATE POLICY tenant_scope ON enrollment_codes
      USING(tenant_id=current_setting('app.tenant_id',true))
      WITH CHECK(tenant_id=current_setting('app.tenant_id',true));
  END IF;
END $$;
-- A login holding CLI permissions cannot defeat tenant isolation by simply
-- changing app.tenant_id in a raw SQL connection.
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['employees','accounts','agents','account_leases',
    'execution_permits','audit_events','enrollment_codes','published_configurations',
    'reviewed_replies','generation_publications','generation_tasks'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename=table_name AND policyname='admin_login_scope') THEN
      EXECUTE format('CREATE POLICY admin_login_scope ON autoreply.%I AS RESTRICTIVE TO autoreply_admin
        USING(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id)))
        WITH CHECK(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id)))',table_name);
    END IF;
  END LOOP;
END $$;
-- Keep execution_permits read-only for this role. Reconciliation needs its own
-- verified, audited workflow; pause/revoke never rewrite an unknown delivery.
-- The function owner uses the separate migration/credential role with BYPASSRLS.
