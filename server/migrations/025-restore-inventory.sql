SET search_path=autoreply,public;
CREATE TABLE IF NOT EXISTS ledger_restore_inventory_uploads (
 tenant_id text NOT NULL,account_id text NOT NULL,id uuid NOT NULL,agent_id text NOT NULL,case_id uuid NOT NULL,
 request_id uuid NOT NULL,challenge_id uuid NOT NULL,manifest_hash text NOT NULL CHECK(manifest_hash ~ '^[a-f0-9]{64}$'),
 manifest_json jsonb NOT NULL CHECK(jsonb_typeof(manifest_json)='object'),issued_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,account_id,id),UNIQUE(tenant_id,account_id,case_id,request_id),UNIQUE(tenant_id,account_id,id,agent_id),
 CHECK(expires_at-issued_at=interval '15 minutes'),
 FOREIGN KEY(tenant_id,account_id,case_id) REFERENCES ledger_restore_reviews(tenant_id,account_id,id),
 FOREIGN KEY(tenant_id,account_id,challenge_id) REFERENCES ledger_restore_pause_reports(tenant_id,account_id,challenge_id)
);
CREATE TABLE IF NOT EXISTS ledger_restore_inventory_pages (
 tenant_id text NOT NULL,account_id text NOT NULL,upload_id uuid NOT NULL,agent_id text NOT NULL,page_index integer NOT NULL CHECK(page_index BETWEEN 0 AND 19999),
 page_hash text NOT NULL CHECK(page_hash ~ '^[a-f0-9]{64}$'),page_json jsonb NOT NULL CHECK(jsonb_typeof(page_json)='object'),
 PRIMARY KEY(tenant_id,account_id,upload_id,page_index),
 FOREIGN KEY(tenant_id,account_id,upload_id,agent_id) REFERENCES ledger_restore_inventory_uploads(tenant_id,account_id,id,agent_id)
);
CREATE TABLE IF NOT EXISTS ledger_restore_inventory_items (
 tenant_id text NOT NULL,account_id text NOT NULL,upload_id uuid NOT NULL,agent_id text NOT NULL,page_index integer NOT NULL,
 item_key text COLLATE "C" NOT NULL CHECK(item_key ~ '^(m:[a-f0-9]{64}:[0-9]{16}|s:[a-f0-9-]{36})$'),
 item_hash text NOT NULL CHECK(item_hash ~ '^[a-f0-9]{64}$'),item_json jsonb NOT NULL CHECK(jsonb_typeof(item_json)='object'),
 PRIMARY KEY(tenant_id,account_id,upload_id,item_key),
 FOREIGN KEY(tenant_id,account_id,upload_id,page_index) REFERENCES ledger_restore_inventory_pages(tenant_id,account_id,upload_id,page_index),
 FOREIGN KEY(tenant_id,account_id,upload_id,agent_id) REFERENCES ledger_restore_inventory_uploads(tenant_id,account_id,id,agent_id)
);
CREATE TABLE IF NOT EXISTS ledger_restore_inventory_receipts (
 tenant_id text NOT NULL,account_id text NOT NULL,upload_id uuid NOT NULL,agent_id text NOT NULL,
 receipt_hash text NOT NULL CHECK(receipt_hash ~ '^[a-f0-9]{64}$'),receipt_json jsonb NOT NULL CHECK(jsonb_typeof(receipt_json)='object'),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,account_id,upload_id),
 FOREIGN KEY(tenant_id,account_id,upload_id,agent_id) REFERENCES ledger_restore_inventory_uploads(tenant_id,account_id,id,agent_id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['ledger_restore_inventory_uploads','ledger_restore_inventory_pages','ledger_restore_inventory_items','ledger_restore_inventory_receipts'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename=t AND policyname='tenant_scope') THEN
   EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=current_setting(''app.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''app.tenant_id'',true))',t);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename=t AND policyname='restore_device_scope') THEN
   EXECUTE format('CREATE POLICY restore_device_scope ON %I AS RESTRICTIVE TO autoreply_app USING(account_id=current_setting(''app.restore_account_id'',true) AND agent_id=current_setting(''app.restore_agent_id'',true)) WITH CHECK(account_id=current_setting(''app.restore_account_id'',true) AND agent_id=current_setting(''app.restore_agent_id'',true))',t);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='autoreply' AND tablename=t AND policyname='admin_login_scope') THEN
   EXECUTE format('CREATE POLICY admin_login_scope ON %I AS RESTRICTIVE TO autoreply_admin USING(EXISTS(SELECT 1 FROM autoreply.authenticate_admin(tenant_id))) WITH CHECK(false)',t);
  END IF;
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,autoreply_app,autoreply_admin,autoreply_learning_worker',t);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO autoreply_app',t);
  EXECUTE format('GRANT SELECT ON %I TO autoreply_admin',t);
 END LOOP;
END $$;
-- Immutable metadata declarations. Neither receipt nor upload grants restore release.
