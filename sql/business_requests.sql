BEGIN;

CREATE SCHEMA IF NOT EXISTS dispatch_private;
REVOKE ALL ON SCHEMA dispatch_private FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS dispatch_private.business_requests (
  id uuid PRIMARY KEY,
  number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  company_id integer NOT NULL DEFAULT 1,
  kind text NOT NULL CHECK (kind IN ('bulk', 'contract')),
  company text NOT NULL,
  contact_name text NOT NULL,
  email text NOT NULL,
  phone text,
  details text NOT NULL,
  service_area text,
  requested_date date,
  stop_count integer CHECK (stop_count BETWEEN 2 AND 10000),
  service_type text NOT NULL CHECK (service_type IN ('courier', 'notary', 'both')),
  frequency text,
  expected_volume text,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewing', 'quoted', 'accepted', 'declined')),
  quote_cents integer CHECK (quote_cents BETWEEN 0 AND 99999999),
  quote_terms text,
  quoted_at timestamptz,
  accepted_at timestamptz,
  acceptance_note text,
  updated_by text,
  activity jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('quoted', 'accepted') OR (quote_cents IS NOT NULL AND quote_terms IS NOT NULL)),
  CHECK (status <> 'accepted' OR (accepted_at IS NOT NULL AND acceptance_note IS NOT NULL)),
  CHECK (
    (kind = 'bulk' AND service_type = 'courier' AND service_area IS NOT NULL AND requested_date IS NOT NULL AND stop_count IS NOT NULL)
    OR (kind = 'contract' AND frequency IS NOT NULL AND expected_volume IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS business_requests_company_status_number_idx
  ON dispatch_private.business_requests (company_id, status, number DESC);

ALTER TABLE dispatch_private.business_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE dispatch_private.business_requests FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE dispatch_private.business_requests_number_seq FROM PUBLIC, anon, authenticated;

COMMIT;
