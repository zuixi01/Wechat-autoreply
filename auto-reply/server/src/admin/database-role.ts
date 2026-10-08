import type { Postgres } from '../database/postgres'

/** A deployment administrator is a distinct, effectively inherited database login. */
export async function assertDedicatedAdminRole(database: Postgres): Promise<void> {
  const role = (
    await database.pool.query(`SELECT current_user=session_user AS same_login,
    rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,
    pg_has_role(session_user,'autoreply_admin','USAGE') AS admin_member,
    EXISTS(SELECT 1 FROM pg_roles p WHERE
      p.rolname IN ('autoreply_app','autoreply_learning_worker','autoreply_jev_reviewer')
      AND pg_has_role(session_user,p.oid,'MEMBER')) AS separate_role_member,
    EXISTS(SELECT 1 FROM pg_roles p WHERE
      (p.rolsuper OR p.rolbypassrls OR p.rolcreaterole OR p.rolcreatedb OR p.rolreplication)
      AND pg_has_role(session_user,p.oid,'MEMBER')) AS privileged_member
    FROM pg_roles WHERE rolname=session_user`)
  ).rows[0]
  if (
    !role ||
    !role.same_login ||
    !role.admin_member ||
    role.rolsuper ||
    role.rolbypassrls ||
    role.rolcreaterole ||
    role.rolcreatedb ||
    role.rolreplication ||
    role.separate_role_member ||
    role.privileged_member
  )
    throw new Error('dedicated_admin_login_required')
}
