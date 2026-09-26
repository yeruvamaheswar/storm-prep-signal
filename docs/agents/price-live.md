# Live LZ_NORTH price (NP6-905-CD)

**Decision (2026-09-26).** The engine and `/v1/snapshot` share one Python price reader. The wall's `readPrice()` in `web/src/liveStamp.ts` stays the browser path. The live public GET stays `settlementPoint=LZ_NORTH`. Archive and the snapshot bind the four load zones from `ercot_prices` rows at that interval. DAM NP4-190 stays out.

## Reader

| Function | File | Job |
|---|---|---|
| `fetch_price` | `server/engine/signal.py` | Same token helper as `fetch_outages`. GET `/np6-905-cd/spp_node_zone_hub?settlementPoint=LZ_NORTH`. |
| `read_price` | `server/engine/signal.py` | `rows_by_name`, then newest `settlementPointPrice` + deliveryDate / Hour / Interval. Stale after 30 min. |
| `stamp_price` | `server/engine/signal.py` | Success: `price_usd_mwh`, `price_label="ercot"`, `price_as_of`. Failure: `None` / `none` / `None`. |

`server/api/feeds.py` `serve_price` calls `signal.fetch_price` in Live. Demo/Synthetic reads `ercot_prices` instead (`docs/agents/archive-feeds.md`). `server/api/snapshot.py` parses with `read_price` and stamps with `stamp_price`. `--live` in `loop.py` fetches once (after a good outage login) and stamps every tick.

`server/api/prices.py` binds `LZ_HOUSTON|NORTH|SOUTH|WEST` from archive/live rows keyed by `(settlement_point, interval_ending)`. It ignores `LZ_AEN|CPS|LCRA|RAYBN`. The tick's `zone_prices` map holds only zones that have a row. `price_label` is `ercot` only when the stamped number came from a row. `GET /v1/snapshot?zone=` and the wall drill-in use that zone's number.

## Failure

A failed live price must not paint tape 185. The tick shows no $/MWh and label `none`. Price picks `Policy.intent` (`docs/agents/policy-intent.md`). It does not pick allocate. The 185 in console fixtures stays a Demo number.

## Not this pass

- A second public GET for the other three LZs (live fetch stays LZ_NORTH)
- DAM NP4-190-CD
- A charge controller (`allocate` still only discharges)
