BEGIN;

CREATE SCHEMA IF NOT EXISTS dispatch_private;
REVOKE ALL ON SCHEMA dispatch_private FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS dispatch_private.driver_support (
  company_id integer PRIMARY KEY,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  contacts jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(contacts) = 'array')
);

ALTER TABLE dispatch_private.driver_support ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE dispatch_private.driver_support FROM PUBLIC, anon, authenticated;
INSERT INTO dispatch_private.driver_support (company_id) VALUES (1) ON CONFLICT DO NOTHING;

COMMIT;
