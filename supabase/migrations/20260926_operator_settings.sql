-- One fleet-wide operator row. The wall POSTs HOLD or AUTO; the live
-- worker reads this before allocate so Render and the laptop share one mode.
-- var/state.json stays the local cache. The engine never reads this table.
-- No default row: an empty table means "use the local file".
-- RLS is on with no policies: anon and authenticated get nothing; the
-- service role bypasses RLS and does every read and upsert.

CREATE TABLE public.operator_settings (
  id text PRIMARY KEY CHECK (id = 'fleet'),
  mode text NOT NULL CHECK (mode IN ('AUTO', 'HOLD')),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.operator_settings ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON TABLE public.operator_settings TO service_role;
