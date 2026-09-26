# Live price: LZ_NORTH headline and four zone prices (NP6-905-CD)

**Decision (2026-09-26).** The engine and `/v1/snapshot` share one Python price reader. The wall's `readPrice()` in `web/src/liveStamp.ts` stays the browser path. The headline live price stays `settlementPoint=LZ_NORTH`. Live runs also fetch the four load zones (`fetch_zone_prices`, below) so each zone's dollars use its own live price. Archive and the snapshot bind the four load zones from `ercot_prices` rows at that interval. DAM NP4-190 stays out.

## Reader

| Function | File | Job |
|---|---|---|
| `fetch_price` | `server/engine/signal.py` | Same token helper as `fetch_outages`. GET `/np6-905-cd/spp_node_zone_hub?settlementPoint=LZ_NORTH`. |
| `read_price` | `server/engine/signal.py` | `rows_by_name`, then newest `settlementPointPrice` + deliveryDate / Hour / Interval. Stale after 30 min. |
| `fetch_zone_prices` | `server/engine/signal.py` | One login, four GETs (`ZONE_POINTS`: LZ_HOUSTON, LZ_NORTH, LZ_SOUTH, LZ_WEST; ERCOT's `settlementPoint` takes one point), merged into one body, saved to `var/signal/latest_np6_zones.json`. Any failed GET fails the whole fetch. |
| `read_zone_prices` | `server/engine/signal.py` | Zone name to $/MWh: each zone's newest interval. A zone older than 30 min or with no row is left out. |
| `stamp_price` | `server/engine/signal.py` | Success: `price_usd_mwh`, `price_label="ercot"`, `price_as_of`. Failure: `None` / `none` / `None`. |

`server/api/feeds.py` `serve_price` calls `signal.fetch_price` in Live. Demo/Synthetic reads `ercot_prices` instead (`docs/agents/archive-feeds.md`). `server/api/snapshot.py` parses with `read_price` and stamps with `stamp_price`. `--live` in `loop.py` fetches once (after a good outage login) and stamps every tick.

`server/api/prices.py` binds `LZ_HOUSTON|NORTH|SOUTH|WEST` from archive/live rows keyed by `(settlement_point, interval_ending)`. It ignores `LZ_AEN|CPS|LCRA|RAYBN`. The tick's `zone_prices` map holds only zones that have a row. `price_label` is `ercot` only when the stamped number came from a row. `GET /v1/snapshot?zone=` and the wall drill-in use that zone's number.

The engine carries the same map. `TapeFrame.zone_prices` / `zone_price_label` (add-only) are copied to `TickResult` in a tape run; `--live` never copies the tape's recorded map; it stamps the map from `load_zone_prices` (label `ercot`), or `{}` / `none` when that fetch fails. `scripts/live_cycle.py` fetches the four zones, upserts every row into `ercot_prices` (`event=live`), and passes the map to `loop.run(live_zone_prices=...)`, so Live `/v1/snapshot` binds all four zones from Supabase too. `server/api/prices.py` `LOAD_ZONE_POINTS` is `signal.ZONE_POINTS`. `scripts/build_tape.py` records all four zones on `tapes/heather.json` (label `recorded:ERCOT NP6-905-CD`); a zone with no row is left out. `score.py` prices `totals.by_zone[zone].dollars` at that zone's own price, never another zone's.

## Failure

A failed live price must not paint tape 185. The tick shows no $/MWh and label `none`. Price picks `Policy.intent` (`docs/agents/policy-intent.md`). It does not pick allocate. The 185 in console fixtures stays a Demo number.

## Not this pass

- DAM NP4-190-CD
- A charge controller (`allocate` still only discharges)
