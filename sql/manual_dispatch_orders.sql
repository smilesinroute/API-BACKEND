BEGIN;

CREATE TABLE IF NOT EXISTS dispatch_private.manual_orders (
  order_id uuid PRIMARY KEY REFERENCES public.orders(id) ON DELETE CASCADE,
  business_request_id uuid REFERENCES dispatch_private.business_requests(id),
  created_by text NOT NULL,
  request_digest text NOT NULL
);

ALTER TABLE dispatch_private.manual_orders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE dispatch_private.manual_orders FROM PUBLIC, anon, authenticated;

COMMIT;
