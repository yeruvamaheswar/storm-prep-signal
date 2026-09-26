-- Current-state fleet: exactly one row per home. Telemetry and ticks upsert
-- these rows; they are not a reading history. Realtime needs the old row
-- (REPLICA IDENTITY FULL). Service role upserts; RLS stays off so it is not blocked.

CREATE TABLE public.homes (
  home_id text PRIMARY KEY,
  zone text NOT NULL CHECK (zone IN ('South', 'North', 'West', 'Houston')),
  capacity_kwh numeric NOT NULL,
  soc_kwh numeric NOT NULL,
  max_kw numeric NOT NULL,
  status text NOT NULL CHECK (status IN ('live', 'stale', 'dead')),
  assigned_kw numeric NOT NULL DEFAULT 0,
  last_seen timestamptz,
  charge_state text CHECK (charge_state IS NULL OR charge_state IN (
    'CHARGING', 'DISCHARGING', 'HOLDING', 'FULL', 'EMPTY'
  )),
  power_kw numeric,
  boot_id text,
  last_seq integer,
  run_id text,
  tick integer,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX homes_zone_idx ON public.homes (zone);
CREATE INDEX homes_zone_status_idx ON public.homes (zone, status);
CREATE INDEX homes_updated_at_idx ON public.homes (updated_at);

ALTER TABLE public.homes REPLICA IDENTITY FULL;

GRANT SELECT, INSERT, UPDATE ON TABLE public.homes TO service_role;
