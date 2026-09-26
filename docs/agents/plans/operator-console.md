# Operator console (Base)

**Decision.** Replace the one-tick layout fixture with the console a Base fleet operator would run for one Texas load zone. The server decides. The wall shows the decision, the data age, and the homes. Writes are fleet policy only: hold, auto, and the fail-safe choices approve, retry once, and skip. This plan ignores the hackathon limits on telemetry and live feeds. It keeps the product limits in `docs/agents/reservegate-summarized.md`.

Look stays `DESIGN.md`: paper field, ink type, color only for state.

## Who it is for

Base fleet operators, on shift, for one load zone. A utility partner who holds dispatch rights can watch the same wall. Homeowners do not sign in and do not dispatch.

## What is wrong with the wall now

The current screen loads a mocked 12-tick file. Squares are counts, not homes. HOLD does not reach a controller. Live ERCOT prices, the outage report, device acknowledgements, and data quality are not on the page. Playback is not distinct from live, because nothing is live.

## Use cases

| # | Operator need | Page | Writes |
|---|---|---|---|
| 1 | See the latest target, price, delivered, missed, floor, and brief, each with source and age | Wall | none |
| 2 | Confirm a price spike sold only energy above the floor | Wall, Log | none |
| 3 | See outage MW cross the line, discharge stop, and the reason | Wall | none |
| 4 | When the feed is bad, choose approve, retry once, or skip. No button returns the fleet to normal selling on bad data | Attention | `POST /v1/attention/{id}` |
| 5 | Watch selling resume only after two calm, clean readings. One bad reading resets the count | Wall | none |
| 6 | See a silent home marked unconfirmed or dead while the others keep the target | Fleet, Home | none |
| 7 | See a rejected command put the whole fleet in reserve | Wall, Attention | none |
| 8 | Hold the fleet, or hand it back to auto | Wall | `POST /v1/fleet/mode` |
| 9 | Open one home to see charge, floor, last ack, and why it got no work | Home | none |
| 10 | Play a tape only by choosing it. The wall must say PLAYBACK | Playback | `POST /v1/playback` |
| 11 | Leave playback and return to live. Live never loads a tape by itself | Playback, Wall | `POST /v1/playback/stop` |
| 12 | Read the shift back: ticks, quality, breaches, briefs | Log | none |

## Pages

Four routes. The wall is the shift. The others explain a home, a tape, or the past.

### `/` Wall

One screen, left aligned, dense.

- Mast: zone name, `LIVE` or `PLAYBACK`, fleet mode `AUTO`, `HOLD`, or `RESERVE`, clock.
- Money row: target MW, delivered MW, missed MW, price $/MWh. Each value shows its source (`ercot`, `utility`, or `tape:<id>`) and its `as_of` time.
- Safety row: reserve percent, sellable MWh, held MWh, breaches. Breaches are a count of homes taken below their floor. The product promise is zero.
- Stress row: outage MW, the published threshold, signed margin, driving zone, level `LOW` or `HIGH`, calm streak `0`, `1`, or `2`, and the outage report’s age.
- Quality row: one word for the tick (`ok` or the named failure) plus the oldest input age.
- Fleet row: counts for live, stale, dead, unconfirmed. Squares are real `home_id`s from `GET /v1/homes`, colored by status. Click opens `/fleet/{home_id}`.
- Brief and reason codes for this tick.
- Attention banner, only when `attention` is set. Three actions: Approve, Retry once, Skip. Copy states that selling does not resume from this banner.
- Mode controls: Hold and Auto. They call the server. They are disabled during playback.
- A thin strip of the last ticks: target against delivered, so the shift is visible without leaving the wall.

`RESERVE` means the safety rule stopped discharge. `HOLD` means the operator stopped it. Both deliver 0. The label must say which.

### `/fleet` and `/fleet/{home_id}`

`/fleet` is a list, not a map. Filter by status. Columns: home id, status, state of charge, floor, kilowatts assigned this tick, last seen, last ack.

`/fleet/{home_id}` is read-only. It shows capacity, charge, floor in kWh, max kW, assigned kW, status, last seen, last command, and ack (`ok`, `rejected`, `timeout`, or none). No discharge button. Fleet hold stays on the wall.

### `/playback`

Lists tapes from `GET /v1/tapes`. Starting one is an explicit act. While it runs, every page shows `PLAYBACK` and the tape id. Stop returns to live and clears the tape. If the live feeds are bad at that moment, the server enters reserve on its own. The UI shows that result. It does not hide it.

### `/log`

Ticks for the shift. Columns: time, mode, target, delivered, missed, price, stress level, quality, breaches, calm streak. A row opens the brief and reasons. Playback ticks are marked so they are not read as live ERCOT.

## Endpoints

Base URL `/v1`. JSON. Times are ISO 8601 with a UTC offset. The UI does not allocate, score, or validate. If the stream drops, the client polls `GET /v1/live`. A stale screen is shown as stale. It is not filled with the last good reading presented as current.

Operator identity is required on every `POST`. There is no homeowner account.

### Reads

| Method and path | Purpose |
|---|---|
| `GET /v1/zone` | The one zone, the reserve policy, the outage threshold |
| `GET /v1/live` | Latest tick, including attention if a human must answer |
| `GET /v1/live/stream` | Server-sent events: `tick`, `attention`, `home` |
| `GET /v1/homes?status=` | Homes for the fleet squares and the list |
| `GET /v1/homes/{home_id}` | One home |
| `GET /v1/ticks?from=&to=` | Log |
| `GET /v1/ticks/{tick_id}` | One past tick and its brief |
| `GET /v1/tapes` | Tapes the operator may choose |
| `GET /v1/playback` | Null when live. Otherwise the tape id and position |

### Writes

| Method and path | Body | Result |
|---|---|---|
| `POST /v1/fleet/mode` | `{ "mode": "HOLD" \| "AUTO" }` | Next tick uses that mode unless a fail-safe forces `RESERVE` |
| `POST /v1/attention/{attention_id}` | `{ "choice": "approve" \| "retry" \| "skip" }` | See choices below. `retry` may be sent once for that attention id |
| `POST /v1/playback` | `{ "tape_id": "..." }` | Enters playback. Refused if a tape is already running |
| `POST /v1/playback/stop` | `{}` | Returns to live |

Approve records that the operator saw the fail-safe. The fleet stays in `RESERVE` until two calm, clean readings. Retry fetches the failed input once. A second failure stays reserve and the choice is spent. Skip drops this target, counts the full target as missed, and stays in reserve. None of the three writes `NORMAL` or `AUTO` over a bad reading.

### Contracts

`GET /v1/zone`

```json
{
  "zone_id": "NP3",
  "zone_name": "North",
  "reserve_pct_normal": 30,
  "reserve_pct_stressed": 60,
  "stress_threshold_mw": 1500,
  "stress_margin_mw": 225,
  "tick_minutes": 5
}
```

`reserve_pct_*`, the threshold, and the margin are policy the server owns. The wall displays them. The margin is the published band around the threshold, not a secret tuning constant hidden from the operator. Example numbers are not Base hardware specs.

`GET /v1/live` and each `tick` event

```json
{
  "tick_id": "tick_01H",
  "ts": "2026-07-08T19:20:00-05:00",
  "source": "live",
  "tape_id": null,
  "mode": "RESERVE",
  "target": {
    "mw": 0.4,
    "source": "ercot",
    "as_of": "2026-07-08T19:19:40-05:00",
    "quality": "ok"
  },
  "price": {
    "usd_mwh": 185,
    "source": "ercot",
    "as_of": "2026-07-08T19:19:50-05:00",
    "quality": "ok"
  },
  "delivered_mw": 0,
  "missed_mw": 0.4,
  "reserve": {
    "pct": 60,
    "reason": "stress_high",
    "sellable_mwh": 0.18,
    "held_mwh": 0.42
  },
  "stress": {
    "outage_mw": 2100,
    "threshold_mw": 1500,
    "margin_mw": 600,
    "zone_id": "NP3",
    "level": "HIGH",
    "as_of": "2026-07-08T19:00:00-05:00",
    "quality": "ok",
    "calm_streak": 0
  },
  "fleet": {
    "live": 70,
    "stale": 10,
    "dead": 18,
    "unconfirmed": 2,
    "breaches": 0
  },
  "quality": "ok",
  "reasons": ["stress_high"],
  "brief": "Delivered 0 of 0.40 MW. Outage capacity is above the line, so the floor is 60% and discharge is stopped.",
  "attention": null
}
```

`source` on the tick is `live` or `playback`. `source` on target and price is `ercot`, `utility`, or `tape:<id>`.

`mode` is `AUTO`, `HOLD`, or `RESERVE`.

`quality` on a tick, and on each input, is one of: `ok`, `timeout`, `http`, `bad_payload`, `missing_field`, `impossible_value`, `stale`.

`reserve.reason` is one of: `normal`, `stress_high`, `signal_untrusted`, `operator_hold`, `command_rejected`.

`reasons` may also include `fleet_headroom_short`, `homes_dead:<n>`, `homes_stale:<n>`, `homes_unconfirmed:<n>`.

`missed_mw` is `target.mw - delivered_mw` and is never negative. `breaches` is the number of homes whose charge ended below their floor on this tick.

`stress.margin_mw` is `outage_mw - threshold_mw`. Positive means above the line. `calm_streak` counts consecutive calm, clean readings. Selling at the normal floor requires `2`. Any other reading sets it back to `0`.

`stress.level` is `LOW`, `HIGH`, or `null`. `null` means the report could not be trusted. The mode is then `RESERVE` and `reserve.reason` is `signal_untrusted`.

When a human must answer, `attention` is:

```json
{
  "attention_id": "att_01H",
  "reason": "timeout",
  "input": "stress",
  "prompt": "Outage report timed out. Discharge is stopped.",
  "choices": ["approve", "retry", "skip"],
  "retry_spent": false
}
```

`input` is `target`, `price`, or `stress`. After a retry has been used, `retry_spent` is true and `choices` is `["approve", "skip"]`.

`GET /v1/homes` item, and `GET /v1/homes/{home_id}`:

```json
{
  "home_id": "home-014",
  "status": "unconfirmed",
  "capacity_kwh": 20,
  "soc_kwh": 11.2,
  "floor_kwh": 12,
  "max_kw": 5,
  "assigned_kw": 0,
  "eligible": false,
  "skip_reason": "unconfirmed",
  "last_seen": "2026-07-08T19:11:00-05:00",
  "last_command": {
    "kw": 0,
    "sent_at": "2026-07-08T19:20:01-05:00",
    "ack": "timeout"
  }
}
```

`status` is `live`, `stale`, `dead`, or `unconfirmed`. `ack` is `ok`, `rejected`, `timeout`, or `null`. `skip_reason` is `null` when the home was eligible, otherwise `below_floor`, `stale`, `dead`, `unconfirmed`, `hold`, or `reserve`.

A `home` stream event is that same object, sent when status, charge, or ack changes.

`GET /v1/tapes` item:

```json
{
  "tape_id": "demo-stress",
  "title": "Outage report goes bad, then two calm readings",
  "ticks": 12,
  "labeled": "synthetic"
}
```

`GET /v1/playback` while running:

```json
{
  "tape_id": "demo-stress",
  "tick_index": 4,
  "tick_count": 12
}
```

While live, the body is `null`.

### Errors

Write calls return `409` when the action is illegal: playback start while a tape is running, retry after `retry_spent`, hold during playback, or an unknown attention id. The body is `{ "error": "<code>", "brief": "<one sentence>" }`. The wall shows `brief` and leaves the fleet mode as the last `GET /v1/live` reported.

## Where the data comes from

The wall never calls ERCOT. The server does, and stamps every number with source, time, and quality.

- **Target and price.** ERCOT or the utility partner. These are the money inputs. A tape may supply them only after the operator starts playback.
- **Stress.** ERCOT’s public hourly resource-outage report for the driving zone. It is supply offline, not a storm forecast and not load. HIGH, stale, malformed, or missing moves the fleet to reserve.
- **Homes.** Base’s own devices: charge, reachability, and command acks. ERCOT does not report garage batteries. The hackathon simulated this list. This console treats it as live device state.

## Still out

Siting maps, billing, install crews, more than one load zone, homeowner accounts, weather as a required signal, per-home dispatch, and any control that turns a bad reading into normal selling.

## Done when

- A live tick shows target, delivered, price, floor, stress, quality, and age without a fixture banner.
- A bad outage report opens Attention, and none of its actions resume selling.
- Two calm, clean readings are visible as the streak, and only the second returns the normal floor.
- A home can be opened from a square, and that page has no discharge control.
- Playback is labeled on every page, and leaving it shows live data or an honest reserve, not the tape.
