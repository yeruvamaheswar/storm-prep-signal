// Task 9 part 2: Live page fixtures, trimmed from real replies of the local API (2026-09-27, re-checked on 162bd0a).
// `archiveSnapshot` is GET /v1/snapshot as served while the run file pins the tuning-2026 archive.
// `liveSnapshot` is the same body as a live worker run stamps it (source "live", feed "LIVE").

export const archiveSnapshot = {
  tick: 1,
  ts: "2026-09-25T12:00:00-05:00",
  mode: "HOLD",
  target_mw: 0.4,
  target_label: "synthetic",
  delivered_mw: 0.4,
  missed_mw: 0.0,
  price_usd_mwh: null,
  price_label: "none",
  reserve_pct: 30.0,
  policy_reason: "normal",
  risk_level: "LOW",
  live_homes: 100,
  stale_homes: 0,
  dead_homes: 0,
  breaches: 0,
  reasons: ["timed_out:1", "duplicates_ignored:1", "over_delivery:1"],
  intent: "hold",
  intent_reason: "",
  zone_reserve_pct: { Houston: 60.0, North: 60.0, South: 60.0, West: 60.0 },
  zone_reasons: { Houston: "storm_risk_high", North: "storm_risk_high", South: "storm_risk_high", West: "storm_risk_high" },
  zone_delivered_mw: { Houston: 0.0965, North: 0.0987, South: 0.1013, West: 0.1035 },
  zone_telemetry: {
    Houston: { grid_down: false }, North: { grid_down: false }, South: { grid_down: false }, West: { grid_down: false },
  },
  brief: "Delivered 0.40 of 0.40 MW. Floor 30% (Houston 60%: storm_risk_high, North 60%: storm_risk_high, South 60%: storm_risk_high, West 60%: storm_risk_high); timed out 1; duplicates ignored 1; over delivery 1.",
  outage_mw: 22137,
  threshold_mw: 23320.85,
  trigger_mw: 23320.85,
  margin_mw: -1183.8499999999985,
  driving_zone: "North",
  as_of: "11:00 CT",
  stress_age_min: 59,
  quality: "ok",
  stress_quality: "ok",
  feed: "ARCHIVE",
  clock_pinned: true,
  source: "archive",
  event: "tuning-2026",
  clock: "archive",
}

export const liveSnapshot = {
  ...archiveSnapshot,
  ts: "2026-09-27T12:20:00-05:00",
  mode: "AUTO",
  intent: "discharge",
  intent_reason: "grid_call",
  price_usd_mwh: 185,
  price_label: "ercot",
  outage_mw: 22539,
  threshold_mw: 22348,
  margin_mw: 191,
  feed: "LIVE",
  clock_pinned: false,
  source: "live",
  event: null,
  clock: "wall",
}

/** 12:20 CT plus 80 s, the same instant in UTC. */
export const NOW_1221 = Date.parse("2026-09-27T17:21:20Z")

export const liveOrders = {
  tick: 1,
  ts: "2026-09-27T12:20:00-05:00",
  orders: {
    "home-001": [[0, "sent", 2.5, "own"], [4.2, "exec", 2.5, "own"], [9.1, "conf", 2.5, "own"]],
    "home-002": [[0, "sent", 1.2, "own"], [0.4, "drop", null, "own"], [60, "retry", null, "own"], [63, "exec", 1.2, "own"], [70, "conf", 1.2, "own"]],
    "home-003": [[0, "sent", -3.0, "own"], [5, "exec", -3.0, "own"], [8, "conf", -3.0, "own"]],
  },
}

/** GET /v1/homes rows as Task 17 serves them for the demo fleet: the engine's zone, county and `name`
 * (home-001 is Houston in every engine output). The table's charge and power are stale seed values the live worker
 * never writes; the page must not read them. */
export const homesRows = [
  { home_id: "home-001", name: "Houston-Harris-001", status: "live", capacity_kwh: 20, soc_kwh: 14, floor_kwh: 12, max_kw: 5, assigned_kw: 2.5, eligible: true, skip_reason: null, charge_state: "DISCHARGING", power_kw: 2.5, zone: "Houston", county: "48201", county_name: "Harris" },
  { home_id: "home-002", name: "North-Dallas-002", status: "live", capacity_kwh: 20, soc_kwh: 0.3, floor_kwh: 12, max_kw: 5, assigned_kw: 0, eligible: false, skip_reason: "below_floor", charge_state: "HOLDING", power_kw: 0, zone: "North", county: "48113", county_name: "Dallas" },
  { home_id: "home-003", name: "South-Nueces-003", status: "live", capacity_kwh: 20, soc_kwh: 5, floor_kwh: 6, max_kw: 5, assigned_kw: 0, eligible: false, skip_reason: "below_floor", charge_state: "CHARGING", power_kw: -3, zone: "South", county: "48355", county_name: "Nueces" },
  { home_id: "home-004", name: "West-Midland-004", status: "stale", capacity_kwh: 20, soc_kwh: 10, floor_kwh: 6, max_kw: 5, assigned_kw: 0, eligible: false, skip_reason: "stale", charge_state: "HOLDING", power_kw: 0, zone: "West", county: "48329", county_name: "Midland" },
  { home_id: "home-005", name: "Houston-FortBend-005", status: "live", capacity_kwh: 20, soc_kwh: 6.05, floor_kwh: 6, max_kw: 5, assigned_kw: 0, eligible: true, skip_reason: null, charge_state: "HOLDING", power_kw: 3.3, zone: "Houston", county: "48157", county_name: "Fort Bend" },
  { home_id: "home-006", status: "live", capacity_kwh: 20, soc_kwh: null, floor_kwh: 6, max_kw: 5, assigned_kw: 0, eligible: true, skip_reason: null, charge_state: null, power_kw: null, zone: "North", county: null, county_name: null },
]

export const homesHeaders = { "x-homes-source": "supabase", "x-fleet-size": "100", "x-homes-total": "100" }

export const rollups = {
  n: 100,
  zones: {
    South: { live: 25, reserved: 0, discharging: 0, stale: 0, dead: 0, silent: 0, reserved_mw: 0, discharging_mw: 0 },
    North: { live: 25, reserved: 0, discharging: 0, stale: 0, dead: 0, silent: 0, reserved_mw: 0, discharging_mw: 0 },
    West: { live: 25, reserved: 0, discharging: 0, stale: 0, dead: 0, silent: 0, reserved_mw: 0, discharging_mw: 0 },
    Houston: { live: 25, reserved: 0, discharging: 0, stale: 0, dead: 0, silent: 0, reserved_mw: 0, discharging_mw: 0 },
  },
  clusters: [],
}

/** GET /v1/runs/latest, trimmed (checked 2026-09-27 on 162bd0a): `settings` is loop.SETTINGS_KEYS and `totals`
 * is the scoreboard. tick_minutes is in both; the snapshot has neither. */
export const runLatest = {
  run_id: "20260927-122000-000001",
  source: "live",
  settings: {
    fleet_size: 100, home_kwh: 25, home_max_kw: 11.4, base_reserve_pct: 30, storm_reserve_pct: 60,
    charge_threshold_usd_mwh: 25, discharge_threshold_usd_mwh: 60, tick_minutes: 5, telemetry_feed: true,
  },
  ticks: [{ tick: 1, ts: "2026-09-27T12:20:00-05:00" }],
  totals: { tick_minutes: 5, ticks: 1 },
}

/** An old Supabase run row from the 10,000-home live fleet (before Task 13), with settings that say so. */
export const oldRun10k = {
  run_id: "20260920-080000-000001",
  source: "live",
  settings: { fleet_size: 10000, base_reserve_pct: 30, storm_reserve_pct: 60, tick_minutes: 5 },
  ticks: [{ tick: 1, ts: "2026-09-27T12:20:00-05:00" }],
}

/** A table row as persist_run stored it before Task 9c: `result` is the ticks only, so /v1/runs/latest has no
 * settings or totals, and /v1/snapshot rescales its tick to the demo fleet (so the tick's counts prove nothing). */
export const tableRunNoSettings = {
  run_id: "20260920-080000-000001",
  source: "live",
  ticks: [{ tick: 1, ts: "2026-09-27T12:20:00-05:00", live_homes: 100 }],
}
