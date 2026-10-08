SET search_path=autoreply,public;
-- Cases/notes are append-only administrative evidence. They do NOT settle permits.
CREATE UNIQUE INDEX IF NOT EXISTS execution_permits_account_id
  ON execution_permits(tenant_id,account_id,id);
CREATE TABLE IF NOT EXISTS reconciliation_cases (
  tenant_id text NOT NULL,account_id text NOT NULL,id text NOT NULL,
  permit_id text NOT NULL,snapshot_hash text NOT NULL CHECK(snapshot_hash ~ '^[a-f0-9]{64}$'),
  snapshot_json jsonb NOT NULL CHECK(jsonb_typeof(snapshot_json)='object'),
  opened_by text NOT NULL,opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,account_id,id),UNIQUE(tenant_id,account_id,permit_id),
  UNIQUE(tenant_id,account_id,id,snapshot_hash),
  FOREIGN KEY(tenant_id,account_id,permit_id) REFERENCES execution_permits(tenant_id,account_id,id),
  FOREIGN KEY(tenant_id,opened_by) REFERENCES employees(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS reconciliation_notes (
  tenant_id text NOT NULL,account_id text NOT NULL,id text NOT NULL,case_id text NOT NULL,
  snapshot_hash text NOT NULL,reference_id text NOT NULL
    CHECK(reference_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  evidence_hash text NOT NULL CHECK(evidence_hash ~ '^[a-f0-9]{64}$'),
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz NOT NULL,recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,account_id,id),
  FOREIGN KEY(tenant_id,account_id,case_id,snapshot_hash)
    REFERENCES reconciliation_cases(tenant_id,account_id,id,snapshot_hash),
  FOREIGN KEY(tenant_id,recorded_by) REFERENCES employees(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS reconciliation_notes_case
  ON reconciliation_notes(tenant_id,account_id,case_id,recorded_at,id);
ALTER TABLE reconciliation_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_cases FORCE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_notes FORCE ROW LEVEL SECURITY;
DO $$ DECLARE t text; actor_column text; BEGIN
  FOREACH t IN ARRAY ARRAY['reconciliation_cases','reconciliation_notes'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename=t AND policyname='tenant_scope') THEN
      EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=current_setting(''app.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''app.tenant_id'',true))',t);
    END IF;
    actor_column := CASE t WHEN 'reconciliation_cases' THEN 'opened_by' ELSE 'recorded_by' END;
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename=t AND policyname='admin_login_scope') THEN
      EXECUTE format('CREATE POLICY admin_login_scope ON %I AS RESTRICTIVE TO autoreply_admin USING(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id))) WITH CHECK(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id) a WHERE a.actor_id=%I))',t,actor_column);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON reconciliation_cases,reconciliation_notes FROM PUBLIC,autoreply_app;
GRANT SELECT,INSERT ON reconciliation_cases,reconciliation_notes TO autoreply_admin;
