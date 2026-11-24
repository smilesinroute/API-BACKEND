-- Archive orders without changing their fulfillment or payment records.
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS archived_by text;
