# Constraints (frozen)

Fields may be added, never renamed or removed.

Source: `docs/reservegate.md` section 2. The data shapes live in `server/engine/contracts.py`.

## How work is chosen

File ownership is retired. The desired end state and the next gap live in `docs/agents/gap-work.md`. A gap may edit any file it needs. Contract fields can be added, never renamed or removed.

## Function contracts

| Function | Signature and promise |
|---|---|
| `reserve_policy` | `(risk: RiskResult \| None, settings, alerted=None, mode="AUTO", price_usd_mwh=None, price_label=None) -> Policy`. HIGH gives `storm_reserve_pct`, LOW gives `base_reserve_pct`, and None gives `storm_reserve_pct` with reason `signal_unavailable` (fail safe means keep more backup). `Policy.intent` is `charge` \| `hold` \| `discharge` when `price_label` is passed. HOLD is hold. Missing price (`none`) is hold with `intent_reason` `price_unavailable`. HIGH or a missing signal may charge when the LZ price is at or below `charge_threshold_usd_mwh`; they never discharge. LOW + AUTO uses the charge and discharge bands. Floor-only callers omit `price_label` and stay hold. `allocate` still only discharges. |
| `new_fleet` | `(settings) -> list[Home]`: `fleet_size` homes, ids `home-001`, and so on. |
| `apply_events` | `(homes, events) -> None`: sets status only. |
| `allocate` | `(homes, frame, policy, mode, settings) -> Allocation`. Pure function: no I/O, no clock, never mutates homes. |
| `discharge` | `(homes, alloc, policy, settings) -> int breaches`: for each signed `per_home_kw`, a positive value lowers `soc_kwh` by `kw × tick_minutes / 60` and never crosses the floor; a negative value raises `soc_kwh` by `|kw| × tick_minutes / 60` and never fills past `capacity_kwh`. `breaches` counts homes discharged below their floor and must be 0. |
| `new_board` / `update` | cumulative target, delivered and missed MWh, total breaches, and lowest soc %. |
| `load_tape` | `(path) -> list[TapeFrame]`. Rejects a frame with no labels or with a naive `ts`. |
| `write_brief` | `(result: TickResult) -> str`, one or two sentences built only from the result's fields. |
| `log_event` | the 7 fields (`ts, run_id, stage, event, ok, reason, data`) plus `decision_line` on the final event. Tick data goes inside `data`. |

`alerted` is a dict of zone name to NWS event name; statewide reasons outrank zone alerts.

## UI. The engine stays the backend.

There is no screen module in the engine. The operator wall is a Vite + React + TypeScript app in `web/`. Look and tokens live in `DESIGN.md`. Python dependencies do not change, except the backend set below. The UI does not allocate, set the reserve, or read the brief to make a decision.

## Backend (`server/`)

`fastapi`, `uvicorn`, and `httpx2` (test client only) join `requirements.txt` (added 2026-09-26). No other dependency is added without updating this section.

- `server/` serves the `/v1` API in `docs/agents/plans/operator-console.md`. That plan's contracts are the API contract. Fields may be added, never renamed.
- HTTP routes in `server/api/` do not allocate, rate risk, or set a reserve floor. Those stay in `server/engine/`. Routes only read their output and record operator writes.
- No write returns the fleet to `AUTO` or normal selling over a bad reading.
- Every `POST` needs `X-Operator-Id`. A refused write is `{ "error", "brief" }`.
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
- `TickResult.intent: str = "hold"` and `TickResult.intent_reason: str = ""`
- `Allocation.per_home_kw` stays one dict; values are now signed (`>0` discharge, `<0` charge)
- `TapeFrame.weather_fixture: Optional[str] = None`
- `Policy.zone_reserve_pct: dict` and `Policy.zone_reasons: dict` (both `default_factory=dict`)
- `TickResult.zone_reserve_pct`, `zone_reasons`, `zone_delivered_mw: dict` (all `default_factory=dict`) and `weather_label: str = "none"`

Rule: zones react only to weather alerts; there is no per-zone ERCOT threshold.

## Stale data

Setting `STALE_AFTER_MIN` in `.env.example`: `STALE_AFTER_MIN=90`. `read_settings()` returns it as `"stale_after_min"` (an int) and defaults to 90.

Setting `CHARGE_BELOW_USD` and `DISCHARGE_ABOVE_USD` in `.env.example`: `CHARGE_BELOW_USD=25`, `DISCHARGE_ABOVE_USD=60`. `read_settings()` returns them as `"charge_threshold_usd_mwh"` and `"discharge_threshold_usd_mwh"`. Simulation bands, not Base specs. They pick `Policy.intent` only. They do not change `allocate`.

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
- `totals` stays `{}` until `score.py` fills it in.
- `source` is `"live"` when the engine ran with `--live` (one ERCOT fetch, its risk used on every tick; a failed fetch means risk None on every tick) and `"scenario"` when each frame's `risk_fixture` was rated.
- `--live` with no tape plays 12 frames at a flat 0.2 MW target labeled `synthetic`, and `tape` is `"synthetic"`.

Rules:

- Fields may be added, never renamed.
- `web/` only reads this file.
- Every MW and $/MWh value keeps its label field next to it.
