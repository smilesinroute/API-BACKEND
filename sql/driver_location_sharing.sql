BEGIN;

CREATE SCHEMA IF NOT EXISTS dispatch_private;
REVOKE ALL ON SCHEMA dispatch_private FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS dispatch_private.driver_live_locations (
  driver_id uuid PRIMARY KEY REFERENCES public.drivers(id) ON DELETE CASCADE,
  event_at timestamptz NOT NULL,
  latitude double precision,
  longitude double precision,
  accuracy_m double precision,
  CONSTRAINT driver_live_locations_valid_point CHECK (
    (latitude IS NULL AND longitude IS NULL AND accuracy_m IS NULL)
    OR (
      latitude IS NOT NULL AND longitude IS NOT NULL AND accuracy_m IS NOT NULL
      AND latitude BETWEEN -90 AND 90
      AND longitude BETWEEN -180 AND 180
      AND accuracy_m BETWEEN 0 AND 100000
    )
  )
);

ALTER TABLE dispatch_private.driver_live_locations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE dispatch_private.driver_live_locations FROM PUBLIC, anon, authenticated;

COMMIT;
