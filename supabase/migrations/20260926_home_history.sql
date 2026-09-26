-- Append-only battery history: one reading and one command per home per tick.
-- public.homes stays one current row per home; these tables keep the movement.
-- No foreign key to public.homes (the seed and the first history write must
-- not order each other). No RLS so the service role is not blocked.
-- Replica identity is not required.

CREATE TABLE public.home_readings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  home_id text NOT NULL,
  tick integer,
  seen_at timestamptz NOT NULL,
  soc_kwh numeric NOT NULL,
  charge_state text,
  power_kw numeric,
  boot_id text,
  seq integer,
  UNIQUE (home_id, tick)
);

CREATE INDEX home_readings_home_seen_idx ON public.home_readings (home_id, seen_at DESC);

CREATE TABLE public.home_commands (
  command_id text PRIMARY KEY,
  home_id text NOT NULL,
  tick integer,
  kw numeric NOT NULL,
  actual_kw numeric,
  ack text CHECK (ack IS NULL OR ack IN ('ok', 'timeout')),
  sent_at timestamptz,
  parent_command_id text
);

CREATE INDEX home_commands_home_sent_idx ON public.home_commands (home_id, sent_at DESC);

GRANT SELECT, INSERT ON TABLE public.home_readings TO service_role;
GRANT SELECT, INSERT ON TABLE public.home_commands TO service_role;
