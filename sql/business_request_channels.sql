BEGIN;

ALTER TABLE dispatch_private.business_requests
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'public'
    CHECK (source IN ('public', 'manual'));

CREATE TABLE IF NOT EXISTS dispatch_private.business_request_sheet (
  company_id integer PRIMARY KEY,
  spreadsheet_id text,
  revision bigint NOT NULL DEFAULT 0,
  synced_revision bigint NOT NULL DEFAULT 0,
  synced_at timestamptz
);

INSERT INTO dispatch_private.business_request_sheet (company_id)
VALUES (1)
ON CONFLICT DO NOTHING;

ALTER TABLE dispatch_private.business_request_sheet ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE dispatch_private.business_request_sheet FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION dispatch_private.queue_business_request_sheet_sync()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  UPDATE dispatch_private.business_request_sheet
  SET revision = revision + 1
  WHERE company_id = NEW.company_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS queue_business_request_sheet_sync ON dispatch_private.business_requests;
CREATE TRIGGER queue_business_request_sheet_sync
  AFTER INSERT OR UPDATE OF status ON dispatch_private.business_requests
  FOR EACH ROW EXECUTE FUNCTION dispatch_private.queue_business_request_sheet_sync();

REVOKE ALL ON FUNCTION dispatch_private.queue_business_request_sheet_sync() FROM PUBLIC, anon, authenticated;

COMMIT;
