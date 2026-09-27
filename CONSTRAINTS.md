# Constraints (frozen)

Fields may be added, never renamed or removed.

Source: `docs/reservegate.md` section 2. The data shapes live in `server/engine/contracts.py`.

## How work is chosen

File ownership is retired. The desired end state and the next gap live in `docs/agents/gap-work.md`. A gap may edit any file it needs. Contract fields can be added, never renamed or removed.

## Function contracts

| Function | Signature and promise |
|---|---|
| `reserve_policy` | `(risk: RiskResult \| None, settings, alerted=None, mode="AUTO", price_usd_mwh=None, price_label=None, zone_prices=None, county_alerts=None, dam_hours=None, zone_hours_needed=None) -> Policy`. HIGH gives `storm_reserve_pct`, LOW gives `base_reserve_pct`, and None gives `storm_reserve_pct` with reason `signal_unavailable` (fail safe means keep more backup). `Policy.intent` is `charge` \| `hold` \| `discharge` when `price_label` is passed. HOLD is hold. Missing price (`none`) is hold with `intent_reason` `price_unavailable`. HIGH or a missing signal may charge when the LZ price is at or below `charge_threshold_usd_mwh`; they never discharge. LOW + AUTO uses the charge and discharge bands. Floor-only callers omit `price_label` and stay hold. On `charge`, `allocate` serves the call, then charges the rest (allocation rule step 8). `Policy.intent` is the price band that `allocate` reads; it is not the tick's label. The tick's `intent` is what the fleet was ordered to do (`controller.acted_intent`, below). With `zone_prices` (zone name to $/MWh) and a price label, every zone in `ZONES` gets `Policy.zone_intent[zone]` from the same bands on its own price; a zone whose reason is `storm_risk_high`, `signal_unavailable` or `weather_alert` never gets `discharge`; a zone with no price takes the fleet intent, except a storm-reason zone holds where that intent is `discharge`. A missing headline price (`none`) does not stop zones that have their own price. HOLD, a floor-only call, or no zone prices leave `zone_intent` empty. With `county_alerts` (added 2026-09-26; JEV gate removed 2026-09-27, user decision), every roster county (`fleet.ZONE_COUNTIES`) of a zone with a named county gets `Policy.county_reserve_pct[fips]` and `county_reasons[fips]`: a named county gets `storm_reserve_pct` / `weather_alert`, whatever the alert type; a county the alert does not name, `base_reserve_pct` / `not_in_alert`. A fleet-wide reason gives every such county the fleet floor and reason, and a zone in `alerted` gives them `storm_reserve_pct` / `weather_alert`. A zone with any named county gets zone reason `weather_alert` and its highest county floor. A home's floor is its county's, else its zone's, else `reserve_pct` (`fleet.floor_kwh`). With `dam_hours` (zone to the next 24 hours of `[{hour_start, usd_mwh}]`, current hour first) and `zone_hours_needed` (zone to whole hours of charging, `fleet.zone_hours_needed`) (added 2026-09-27), a zone that has both replaces its $25 charge test with the cheapest-DAM-hours rule: the zone's chosen hours are its `zone_hours_needed` cheapest DAM hours (ties to the earlier hour); it charges when this hour is chosen or its real-time price is at or below the dearest chosen hour, and some later DAM hour × `round_trip_pct` / 100 is above the price now (real-time, else this hour's DAM). Otherwise it holds. The discharge band still wins (why `sell_band`), and a storm-reason zone still never gets `discharge`. `Policy.zone_charge_hours[zone]` gets the chosen hour starts and `Policy.zone_charge_why[zone]` one of `dam_cheap_hour`, `rt_dip`, `cheaper_hour_later`, `no_payback`, `full`, `sell_band`. DAM hours alone (no zone prices) still fill `zone_intent`. A zone with no DAM hours keeps the bands; HOLD or a floor-only call leaves `zone_intent`, `zone_charge_hours` and `zone_charge_why` empty. Rule and evidence: `docs/agents/policy-intent.md` "Cheapest DAM hours". |
| `acted_intent` | `(alloc, policy, mode) -> (intent, intent_reason)`. Pure. HOLD mode is hold / `operator_hold`. Net flow picks the label: sold = sum of planned `>0` kW, charged = size of the `<0` kW. Charged > sold is charge (`grid_call_served` if anything sold; else the policy reason when the fleet band is charge, or `zone_price` when only zone prices said charge). Added 2026-09-27: when a `charge` zone's `zone_charge_why` is `dam_cheap_hour` (else `rt_dip`), a charge tick with nothing sold reads that reason instead; `reserve_refill` (only under-floor homes charged) still comes first. Otherwise sold > 0 is discharge (policy reason if the band said discharge, else `grid_call`); an exact tie is discharge, and a mixed discharge tick keeps `charging` in `reasons`. Nothing moved is hold (`no_grid_call` when the band said charge or discharge and the target was 0, otherwise the policy reason). Table: `docs/agents/policy-intent.md`. |
| `new_fleet` | `(settings) -> list[Home]`: `fleet_size` homes, ids `home-001`, and so on. |
| `apply_events` | `(homes, events) -> None`: sets status only. |
| `allocate` | `(homes, frame, policy, mode, settings) -> Allocation`. Pure function: no I/O, no clock, never mutates homes. |
| `discharge` | `(homes, alloc, policy, settings) -> int breaches`: for each signed `per_home_kw`, a positive value lowers `soc_kwh` by `kw × tick_minutes / 60` and never crosses the floor; a negative value raises `soc_kwh` by `|kw| × tick_minutes / 60` and never fills past `capacity_kwh`. `breaches` counts homes discharged below their floor and must be 0. |
| `new_board` / `update` | cumulative target, delivered and missed MWh, total breaches, and lowest soc %. |
| `load_tape` | `(path) -> list[TapeFrame]`. Rejects a frame with no labels or with a naive `ts`. |
| `write_brief` | `(result: TickResult) -> str`, one or two sentences built only from the result's fields. |
| `log_event` | the 7 fields (`ts, run_id, stage, event, ok, reason, data`) plus `decision_line` on the final event. Tick data goes inside `data`. |

`alerted` is a dict of zone name to NWS event name (a whole-zone alert, from the frame's `weather` event); statewide reasons outrank zone alerts. `county_alerts` is a dict of county FIPS (a string) to the NWS event name of the alert naming it (changed 2026-09-27 from JEV P(yes)), from the frame's `weather_counties` event; statewide reasons and whole-zone alerts outrank it.

## UI. The engine stays the backend.

There is no screen module in the engine. The operator wall is a Vite + React + TypeScript app in `web/`. Look and tokens live in `DESIGN.md`. Python dependencies do not change, except the backend set below. The UI does not allocate, set the reserve, or read the brief to make a decision.

UI dependencies added for the redesigned ReserveGate shell (2026-09-26): `@fontsource/overpass`, `three`, and `@react-three/fiber` v9 for React 19. The old wall tokens stay available while new `--rg-*` tokens are added for Replay `/`, Live `/live`, and Fleet `/fleet`.

## Backend (`server/`)

`fastapi`, `uvicorn`, and `httpx2` (test client only) join `requirements.txt` (added 2026-09-26). No other dependency is added without updating this section.

- `server/` serves the `/v1` API in `docs/agents/plans/operator-console.md`. That plan's contracts are the API contract. Fields may be added, never renamed.
- HTTP routes in `server/api/` do not allocate, rate risk, or set a reserve floor. Those stay in `server/engine/`. Routes only read their output and record operator writes.
- No write returns the fleet to `AUTO` or normal selling over a bad reading.
- Every `POST` needs `X-Operator-Id`. A refused write is `{ "error", "brief" }`.
- Scenario routes for `/flow` (added 2026-09-26, `server/api/scenario.py`): `GET /v1/scenarios`, `GET /v1/scenario/state`, `GET /v1/scenario/verify?event=&clock=`, and `POST /v1/scenario/start`, `reset`, `play`, `speed`, `alert`, `grid-down`. Each POST only appends a request to `var/scenario/requests.json`; `scripts/scenario_session.py` is the only process that runs the engine for a scenario. Detail: `docs/agents/grid-flow.md`.
- Details for agents: `docs/agents/backend.md`.

How they connect:

1. The engine still writes the JSONL log. Each `stage == "tick"` line carries a `TickResult` inside `data`, plus `brief`.
2. At the end of the run, `server/engine/loop.py` writes `var/runs/<run_id>.json` from those tick lines. Shape: `{ "run_id", "decision_line", "ticks" }`. Each tick is the `TickResult` fields plus `brief`. Field names match `server/engine/contracts.py`. They may be added, never renamed or removed.
3. `demo.sh` copies that file to `web/public/runs/latest.json`. The app fetches `/runs/latest.json`. `web/src/contracts.ts` repeats those field names for TypeScript. `contracts.py` wins if they disagree.
4. HOLD and AUTO are already `TickResult.mode`, set from the tape. Buttons on screen do not call the engine.

```
server/engine/contracts.py  TickResult and the other shapes
server/engine/loop.py       writes var/runs/<run_id>.json
server/api/                 /v1 HTTP routes
server/app.py               FastAPI entry
var/runs/<run_id>.json      generated, not committed
web/                        Vite + React + TypeScript
  src/contracts.ts          same field names as TickResult
  src/design/               tokens
  src/components/atoms/
  src/components/molecules/
  src/components/organisms/
  src/components/templates/
  src/pages/                mounts the operator wall
  public/runs/latest.json   copy of the latest run file, not committed
DESIGN.md                   how the wall looks
```

## Allocation rule (must be sayable out loud)

1. If mode is HOLD, give every home 0 kW, set missed to the target, and add reason `operator_hold`.
2. A home is eligible only if it's `live`. Dead and stale homes get 0, because we don't send work to a home we can't hear from.
3. Headroom is `soc_kwh − reserve_pct/100 × capacity_kwh`. A home's cap is `min(max_kw, headroom_kwh × 60 / tick_minutes)`, and a home with no headroom has cap 0.
4. If the sum of caps is at or below the target, every home runs at its cap. Otherwise each home gets `cap × target / sum_caps` (proportional).
5. `missed = target − delivered`. Add reason codes whenever missed is above 0.
6. `per_home_kw` is signed on one field (not `per_home_charge_kw` / `per_home_discharge_kw`). A positive value is discharge (sell). A negative value is charge (absorb). Charge raises `soc_kwh` by `|kw| × tick_minutes / 60` and must not fill past `capacity_kwh`. Discharge still never crosses the floor. Charge is not a breach. `breaches == 0` on every tick.
7. A home in a zone named by the frame's `grid_down` event gets 0 kW in both directions; it backs up its own home. Add reason `grid_down:<zone>` for each such zone, after the other codes. The worker runs 0 for any order that reaches such a home, and reassignment never picks one. `missed = target − delivered` still applies. A zone name not in `ZONES` is an error, not a quiet skip. (Added 2026-09-26.)
8. On a cheap tick (`Policy.intent == "charge"`), serve the call, then charge the rest. Pick just enough live homes to cover the target, most headroom first (ties by `home_id`), and split the target across only those homes by step 4. Every other live home with room charges at `min(max_kw, room_kwh × 60 / tick_minutes)`. A home never sells and charges in one tick. With target 0, every live home with room charges. Reasons: the shortfall code if missed, then `charging`, then the status codes. Steps 1, 2 and 7 still apply. (Added 2026-09-26.)
9. When `Policy.zone_intent` is set, each zone follows its own band, and the call is still served while any zone has headroom. Every live home with headroom in a `discharge` or `hold` zone (a zone with no row is hold) shares the target by step 4. Only if their caps fall short do `charge`-zone homes sell the remainder: the fewest that cover it, most headroom first, ties by `home_id`. Every other live home in a `charge` zone charges at its room cap. Other non-selling homes do nothing: the fleet sells only on a call. Reasons as step 8. Steps 1, 2 and 7 still apply. (Added 2026-09-26.) With DAM hours on the tick, which zones are `charge` comes from the cheapest-DAM-hours rule (`reserve_policy` row); this step itself is unchanged. (Note added 2026-09-27.)
10. After steps 4 to 9, every live home in a known zone whose grid is up, is under its zone floor, and has no order yet charges at `min(max_kw, (floor_kwh − soc_kwh) × 60 / tick_minutes)`, at any price. It stops at the floor. Add reason `reserve_refill` after the shortfall and `charging` codes. Steps 1, 2 and 7 still apply. (Added 2026-09-26, Rajat: the reserve must be in place before a storm.)

## Invariants (the tests and `CONSTRAINTS.md` both state these)

- No home is ever discharged below its floor, so `breaches == 0` on every tick of every tape. Charge raises state of charge; it does not count as a breach.
- `0 ≤ delivered ≤ target` and `missed == target − delivered`, compared with a small tolerance.
- Dead and stale homes get 0 kW, and HOLD delivers 0.
- Nothing reads the brief. It's written after the decision.
- Every target and price shown on screen shows its label. No unlabeled $/MWh or MW anywhere.

## Zones

Setting `ZONES` in `.env.example`: `ZONES=Houston:48201,North:48113,South:48355,West:48329`. These are ERCOT's 4 load zones, each with one anchor county (Harris, Dallas, Nueces, Midland). `read_settings()` returns it as `"zones"`, a dict of zone name to county FIPS code (a string), and defaults to the same value.

New contract fields, all with defaults:

- `Home.zone: str = ""`
- `Home.updated_at: str = ""` (ISO 8601 with UTC offset; empty until the fleet stamps a write)
- `Policy.intent: str = "hold"` and `Policy.intent_reason: str = ""` (`charge` \| `discharge` \| `hold`)
- `TickResult.intent: str = "hold"` and `TickResult.intent_reason: str = ""` (from `acted_intent`, so it names what the fleet was ordered to do this tick; reasons add `grid_call`, `no_grid_call` and `zone_price`)
- `Allocation.per_home_kw` stays one dict; values are now signed (`>0` discharge, `<0` charge)
- `TapeFrame.weather_fixture: Optional[str] = None`
- `Policy.zone_reserve_pct: dict` and `Policy.zone_reasons: dict` (both `default_factory=dict`)
- `TickResult.zone_reserve_pct`, `zone_reasons`, `zone_delivered_mw: dict` (all `default_factory=dict`) and `weather_label: str = "none"`
- `TickResult.plant`, `feed`, `zone_telemetry: dict` (all `default_factory=dict`; empty when `TELEMETRY_FEED=0`). Shapes: `docs/agents/telemetry-vpp.md`.
- `TickResult.charging_mw: float = 0.0` and `zone_charging_mw: dict` (confirmed MW absorbed from the grid; never counted in `delivered_mw`), and `TickResult.grid_down_zones: list` (sorted zone names from the frame's `grid_down` event). Added 2026-09-26.

- `Policy.zone_intent: dict` (`default_factory=dict`; zone name to `charge` \| `hold` \| `discharge`, set only from zone prices). Added 2026-09-26.
- `Home.county: str = ""` (county FIPS from `fleet.ZONE_COUNTIES`, a simulation roster; the `/flow` session assigns it, `new_fleet` leaves it empty). Added 2026-09-26.
- `Policy.county_reserve_pct: dict`, `Policy.county_reasons: dict`, `TickResult.county_reserve_pct: dict`, `TickResult.county_reasons: dict` (all `default_factory=dict`; county FIPS to the floor percent that county's homes keep and its reason, for every roster county of a zone an active alert names; empty with no county alert). Added 2026-09-26.
- `TapeFrame.dam_fixtures: list` (`default_factory=list`; paths of the NP4-190-CD day files published at that tick: today's, plus tomorrow's from 13:30 CT). Added 2026-09-27.
- `Policy.zone_charge_hours: dict` and `Policy.zone_charge_why: dict` (both `default_factory=dict`; zone to the chosen DAM hour starts, and zone to `dam_cheap_hour` \| `rt_dip` \| `cheaper_hour_later` \| `no_payback` \| `full` \| `sell_band`; set only for zones with DAM hours). Added 2026-09-27.
- `TickResult.dam_hours`, `zone_hours_needed`, `zone_charge_hours`, `zone_charge_why: dict` (all `default_factory=dict`; `dam_hours` is zone to `[{hour_start, usd_mwh}]`, the 24-hour window the rule read), `TickResult.dam_label: str = "none"` (`ercot` on Live, `recorded:ERCOT NP4-190-CD` on tapes) and `TickResult.dam_as_of: Optional[str] = None` (the delivery dates read, comma-separated). Added 2026-09-27. Detail: `docs/agents/dam-forecast.md`.

Rule: zone and county floors react only to weather alerts; there is no per-zone ERCOT outage threshold. A county an active alert names keeps the storm reserve, whatever the alert type; a county the alert does not name keeps the base floor (changed 2026-09-27: JEV removed, user decision). Zone intent reads each zone's own price (allocation rule step 9), and with DAM hours each zone charges in its cheapest DAM hours (added 2026-09-27).

## Stale data

Setting `STALE_AFTER_MIN` in `.env.example`: `STALE_AFTER_MIN=90`. `read_settings()` returns it as `"stale_after_min"` (an int) and defaults to 90.

Setting `HOME_KWH` and `HOME_MAX_KW` in `.env.example`: `HOME_KWH=25`, `HOME_MAX_KW=11.4` (the public base pack, PR #31). `read_settings()` returns them as `"home_kwh"` and `"home_max_kw"` and defaults to the same values. The fleet cap is `fleet_size × home_max_kw`, so 10,000 homes is 114 MW; the fleet-cap meta tests expect that and fail with an older `.env` (for example 20 kWh / 5 kW gives 50 MW). `render.yaml` pins the same values.

Setting `CHARGE_BELOW_USD` and `DISCHARGE_ABOVE_USD` in `.env.example`: `CHARGE_BELOW_USD=25`, `DISCHARGE_ABOVE_USD=60`. `read_settings()` returns them as `"charge_threshold_usd_mwh"` and `"discharge_threshold_usd_mwh"`. Simulation bands, not Base specs. They pick `Policy.intent` and, with zone prices, `Policy.zone_intent`. `allocate` reads those bands (steps 8 and 9).

Setting `ROUND_TRIP_PCT` in `.env.example`: `ROUND_TRIP_PCT=89` (added 2026-09-27). `read_settings()` returns it as `"round_trip_pct"` (a float) and defaults to 89; `render.yaml` pins the same value. The cheapest-DAM-hours payback test keeps this share of a later hour's price. 89% is the Powerwall 3 datasheet round trip (`docs/agents/telemetry-vpp.md` R11), an example setting, not a Base spec. There is no charge-hours setting: `fleet.zone_hours_needed` sizes the hours from charge.

- `--live` only: if the newest posting is more than `stale_after_min` minutes old, the signal is unavailable with reason `data is <N> min old (limit 90)`. Risk is None, so the floor is `storm_reserve_pct` with reason `signal_unavailable`.
- `--fixture` and `--file` are recorded on purpose. Their clock is pinned to the posting, and they are never rejected for age.
- A missing or too-short `data/baseline_by_lead.json` is a setup error in every mode. The run stops, as the engine does. It is never reported as signal unavailable.

## Tape file format (read by `load_tape`)

A tape is one JSON object with a `label` and a list of `frames`. Each frame holds the `TapeFrame` fields from `server/engine/contracts.py`.

```json
{
  "label": "str",
  "frames": [
    {
      "tick": 0, "ts": "2026-09-25T12:00:00-05:00",
      "target_mw": 0.0, "target_label": "synthetic",
      "price_usd_mwh": null, "price_label": "none",
      "risk_fixture": null,
      "events": {}
    }
  ]
}
```

- `risk_fixture`, `weather_fixture` and `events` are optional in a frame; every other `TapeFrame` field is required.
- `events` keys are listed on `TapeFrame` in `server/engine/contracts.py`. `"grid_down": ["Houston"]` (added 2026-09-26) names zones whose batteries only back up their own homes that tick: no sell, no charge (allocation step 7). `"weather_counties": {"48201": "Tropical Storm Warning"}` (added 2026-09-26; value changed 2026-09-27 from JEV P(yes)) names counties under an alert that tick, each with the NWS event name of the alert naming it (two alerts on one county: the first is kept); it feeds `reserve_policy(..., county_alerts=)`.
- `"dam_fixtures": ["data/fixtures/dam/np4_190_cd_20260830.json"]` (added 2026-09-27, optional) lists the NP4-190-CD day files published at that tick. The tape builder decides what was published; the engine never guesses publish times. A frame without it runs on the $25/$60 bands. A live run never reads it (it uses the day files the live worker fetched).
- `load_tape` still returns `list[TapeFrame]` (the frames only).
- Fields may be added, never renamed.

## Engine output (read by web/)

The engine writes one file per run to `var/runs/<run_id>.json`, plus `var/runs/latest.json`, which is a copy of the most recent run.

Shape:

```json
{
  "run_id": "str",
  "tape": "str (path to the tape file)",
  "source": "str (\"live\" or \"scenario\")",
  "settings": {
    "fleet_size": 0,
    "home_kwh": 0.0,
    "home_max_kw": 0.0,
    "base_reserve_pct": 0.0,
    "storm_reserve_pct": 0.0,
    "tick_minutes": 0
  },
  "ticks": [
    {
      "tick": 0, "ts": "", "mode": "",
      "target_mw": 0.0, "target_label": "",
      "delivered_mw": 0.0, "missed_mw": 0.0,
      "price_usd_mwh": null, "price_label": "",
      "reserve_pct": 0.0, "policy_reason": "", "risk_level": null,
      "live_homes": 0, "stale_homes": 0, "dead_homes": 0,
      "breaches": 0, "reasons": [],
      "intent": "hold", "intent_reason": "",
      "brief": ""
    }
  ],
  "totals": {}
}
```

- Each item in `ticks` holds every `TickResult` field from `server/engine/contracts.py`, plus `brief` (a string).
- `totals` holds the `score.py` board: `ticks`, `delivered_mwh`, `target_mwh`, `breaches`, `delivery_pct`, `hold_ticks`. Fields may be added, never renamed.
- `source` is `"live"` when the engine ran with `--live` (one ERCOT fetch, its risk used on every tick; a failed fetch means risk None on every tick) and `"scenario"` when each frame's `risk_fixture` was rated.
- `--live` with no tape plays 12 frames at a flat 0.2 MW target labeled `synthetic`, and `tape` is `"synthetic"`.

Rules:

- Fields may be added, never renamed.
- `web/` only reads this file.
- Every MW and $/MWh value keeps its label field next to it. The $/MWh values in `dam_hours` are labeled by `dam_label` (added 2026-09-27).
