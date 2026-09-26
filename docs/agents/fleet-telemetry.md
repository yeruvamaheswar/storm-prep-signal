# Last telemetry on the fleet list

**Decision (2026-09-26).** `/fleet` shows the last streamed reading on the same paged homes list. Home JSON is add-only: optional `charge_state` and `power_kw`. No new route. Never fetch 10k rows. `boot_id` and `last_seq` stay off the list.

## Why

`persist_telemetry.py` upserts last readings onto `public.homes`. `GET /v1/homes` already pages that table and already returns `last_seen`. The list was missing charge state and power, so an operator could not see what the feed last reported.

## Contract

Add-only on the console Home:

| Field | Values | Missing |
|---|---|---|
| `charge_state` | `CHARGING` \| `DISCHARGING` \| `HOLDING` \| `FULL` \| `EMPTY` | `null` |
| `power_kw` | number, + discharge / − charge | `null` |

`last_seen` is unchanged. Empty last reading paints as an em dash, not a fake `HOLDING` or `0`.

## Screen

`/fleet` columns, after assigned kW: Charge state, Power, Last seen. Color only for state (`DESIGN.md`): discharging OK, charging Reserved, holding/full/empty muted. `/fleet/{home_id}` shows the same two facts. Look stays paper field, ink type.

## Out

A `/telemetry` route, feed-health strip, sort/filter by last seen, `boot_id` / `last_seq` on the table, history.

People page: `docs/humans/fleet-telemetry.md`. Persist writer: `docs/agents/persist-telemetry.md`.
