# Constraints (frozen)

Fields may be added, never renamed or removed. Change only with Uma.

Source: `docs/reservegate.md` section 2. The data shapes live in `storm_prep/contracts.py`.

## Files and owners (one owner per file; nobody else edits it)

| Owner | Files |
|---|---|
| **Uma** (policy core, glue, and merges) | `storm_prep/contracts.py`, `CONSTRAINTS.md`, `storm_prep/policy.py`, `storm_prep/engine.py`, and the existing `signal.py`, `risk.py`, `events.py`, `decision.py`, `__main__.py`, `batteries.py` (frozen, left alone). Shared files: `requirements.txt`, `.env.example`, `AGENTS.md`, `docs/*`, `pytest.ini`. Tests: `tests/test_risk.py`, `test_run.py`, `test_policy.py`, `test_engine.py`, `tests/fixtures/np3_*.json` |
| **Rajath** (controller and stress) | `storm_prep/controller.py`, `storm_prep/fleet.py`, `storm_prep/score.py`, `tests/test_controller.py`, `tests/test_fleet.py`, `tests/test_score.py`, `tests/fixtures/homes_*.json` |
| **Sunny** (story) | `storm_prep/tape.py`, `storm_prep/brief.py`, `storm_prep/screen.py`, `tapes/*.json`, `tests/test_tape.py`, `tests/test_brief.py`, `tests/test_screen.py`, `demo.sh`, `.github/workflows/tests.yml`, `README.md`, `docs/pitch.md`, `app/` (stretch) |

If you need something in a file you don't own, like a new dependency, a new setting, or a new contract field, ask its owner in a PR comment. Contract fields can be added, never renamed or removed.

## Function contracts

| Function | Owner | Signature and promise |
|---|---|---|
| `reserve_policy` | Uma | `(risk: RiskResult \| None, settings, alerted=None) -> Policy`. HIGH gives `storm_reserve_pct`, LOW gives `base_reserve_pct`, and None gives `storm_reserve_pct` with reason `signal_unavailable` (fail safe means keep more backup). |
| `new_fleet` | Rajath | `(settings) -> list[Home]`: `fleet_size` homes, ids `home-001`, and so on. |
| `apply_events` | Rajath | `(homes, events) -> None`: sets status only. |
| `allocate` | Rajath | `(homes, frame, policy, mode, settings) -> Allocation`. Pure function: no I/O, no clock, never mutates homes. |
| `discharge` | Rajath | `(homes, alloc, policy, settings) -> int breaches`: lowers soc by `kw × tick_minutes / 60`. |
| `new_board` / `update` | Rajath | cumulative target, delivered and missed MWh, total breaches, and lowest soc %. |
| `load_tape` | Sunny | `(path) -> list[TapeFrame]`. Rejects a frame with no labels or with a naive `ts`. |
| `write_brief` | Sunny | `(result: TickResult) -> str`, one or two sentences built only from the result's fields. |
| `render` | Sunny | `(log_path) -> Path`: one static HTML file from `stage == "tick"` events. No server needed. |
| `log_event` | Uma (exists) | the 7 fields (`ts, run_id, stage, event, ok, reason, data`) plus `decision_line` on the final event. Tick data goes inside `data`. |

alerted is a dict of zone name to NWS event name; statewide reasons outrank zone alerts.

## Allocation rule (Rajath implements it; Uma must be able to say it out loud)

1. If mode is HOLD, give every home 0 kW, set missed to the target, and add reason `operator_hold`.
2. A home is eligible only if it's `live`. Dead and stale homes get 0, because we don't send work to a home we can't hear from.
3. Headroom is `soc_kwh − reserve_pct/100 × capacity_kwh`. A home's cap is `min(max_kw, headroom_kwh × 60 / tick_minutes)`, and a home with no headroom has cap 0.
4. If the sum of caps is at or below the target, every home runs at its cap. Otherwise each home gets `cap × target / sum_caps` (proportional).
5. `missed = target − delivered`. Add reason codes whenever missed is above 0.

## Invariants (the tests and `CONSTRAINTS.md` both state these)

- No home is ever discharged below its floor, so `breaches == 0` on every tick of every tape.
- `0 ≤ delivered ≤ target` and `missed == target − delivered`, compared with a small tolerance.
- Dead and stale homes get 0 kW, and HOLD delivers 0.
- Nothing reads the brief. It's written after the decision.
- Every target and price shown on screen shows its label. No unlabeled $/MWh or MW anywhere.

## Zones

Setting `ZONES` in `.env.example`: `ZONES=Houston:48201,North:48113,South:48355,West:48329`. These are ERCOT's 4 load zones, each with one anchor county (Harris, Dallas, Nueces, Midland). `read_settings()` returns it as `"zones"`, a dict of zone name to county FIPS code (a string), and defaults to the same value.

New contract fields, all with defaults:

- `Home.zone: str = ""`
- `TapeFrame.weather_fixture: Optional[str] = None`
- `Policy.zone_reserve_pct: dict` and `Policy.zone_reasons: dict` (both `default_factory=dict`)
- `TickResult.zone_reserve_pct`, `zone_reasons`, `zone_delivered_mw: dict` (all `default_factory=dict`) and `weather_label: str = "none"`

Rule: zones react only to weather alerts; there is no per-zone ERCOT threshold.

## Stale data

Setting `STALE_AFTER_MIN` in `.env.example`: `STALE_AFTER_MIN=90`. `read_settings()` returns it as `"stale_after_min"` (an int) and defaults to 90.

- `--live` only: if the newest posting is more than `stale_after_min` minutes old, the signal is unavailable with reason `data is <N> min old (limit 90)`. Risk is None, so the floor is `storm_reserve_pct` with reason `signal_unavailable`.
- `--fixture` and `--file` are recorded on purpose. Their clock is pinned to the posting, and they are never rejected for age.
- A missing or too-short `data/baseline_by_lead.json` is a setup error in every mode. The run stops, as the engine does. It is never reported as signal unavailable.

## Tape file format (read by `load_tape`)

A tape is one JSON object with a `label` and a list of `frames`. Each frame holds the `TapeFrame` fields from `storm_prep/contracts.py`.

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
      "brief": ""
    }
  ],
  "totals": {}
}
```

- Each item in `ticks` holds every `TickResult` field from `storm_prep/contracts.py`, plus `brief` (a string).
- `totals` stays `{}` until `score.py` fills it in.

Rules:

- Fields may be added, never renamed.
- `web/` only reads this file.
- Every MW and $/MWh value keeps its label field next to it.
