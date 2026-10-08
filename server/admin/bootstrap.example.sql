-- Run using the separate migration/credential operator AFTER migrations 001–004.
-- Replace the example IDs. Configure login authentication through your secret
-- manager; never put a password into this source file. Do not grant this role
-- to the ordinary API login or distribute its connection string to employees.
CREATE ROLE your_admin_login LOGIN INHERIT NOSUPERUSER NOBYPASSRLS;
GRANT autoreply_admin TO your_admin_login;
INSERT INTO autoreply.tenants(id,name) VALUES('your-company','你的企业');
INSERT INTO autoreply.employees(tenant_id,id,role)
  VALUES('your-company','your-admin','admin');
INSERT INTO autoreply.admin_database_principals(login_name,tenant_id,employee_id)
  VALUES('your_admin_login','your-company','your-admin');
-- The schema/function owner must use the migration role with BYPASSRLS.
-- Administrator login itself must have neither superuser nor BYPASSRLS.
