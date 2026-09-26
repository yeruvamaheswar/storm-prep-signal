```markdown
# ReserveGate

## Problem
Base sells power from home batteries when ERCOT is expensive. Those homes still need backup if the grid fails. Emptying a house for wholesale profit is a product failure.

The data behind that choice can be late, missing, or wrong. The two mistakes are not equal. Missing a dispatch target costs money. Running normal on bad data, or selling through a reserve floor before a grid event, can leave a family without power.

## What this is
An operator product for one Texas load zone. It follows a dispatch target from ERCOT or a utility, sells only energy above each home’s reserve, and fails safe when the grid looks stressed or the data cannot be trusted.

Storm Prep is the safety layer inside that loop: a public ERCOT outage-capacity reading rates supply-side stress. HIGH or untrusted data raises reserve and freezes discharge. Returning to normal selling needs two calm, clean readings in a row.

## Who it is for
Base fleet operators first. Utility partners who hold dispatch rights second. Homeowners do not drive the battery. They only need the backup promise kept.

## Why it matters
- **Open Grid Data** — real ERCOT conditions (prices and outage capacity), not toy numbers
- **Orchestration** — many independent homes; a silent device is marked, not pretended
- **Most Commercializable** — a wall an operator can watch and override at policy level

## How it decides
Base does not invent the megawatt number. Base offers. ERCOT or a utility sends a **target**. ReserveGate allocates only homes above the reserve floor.

Separately, ERCOT’s hourly resource outage report is a **stress signal**, not a storm forecast. It says how much generation is offline. If that reading is HIGH, stale, malformed, or missing, the system does not keep selling. It goes to reserve, logs why, and asks a human to approve, retry once, or skip.

Live mode never quietly swaps in a recorded tape. Tape is only used when the operator chooses playback.

## Outcome
A judge can follow this in one minute:
1. A dispatch target arrives and the fleet delivers from energy above reserve
2. Price moves; only surplus energy is sold
3. Outage MW crosses the line, or the feed goes bad — reserve rises, discharge stops, the line says why
4. Some homes go stale or silent — they are marked UNCONFIRMED or dead; the rest keep working
5. Two calm, clean readings later, normal selling can resume
6. Delivered vs target, reserve breaches, data quality, and a short brief are all visible

## Core flows
1. **Watch.** Live grid data or a chosen tape. Operator sees price, target, delivered, reserve breaches, data age, and quality.
2. **Follow a target.** Work goes only to homes above the floor.
3. **Price spike.** Sell only above reserve.
4. **Stress or bad data.** Outage HIGH, or validate fails (timeout, HTTP, bad payload, missing field, impossible value, stale). Fail-safe: fleet RESERVE, reason on the line, human A/R/S. Missing the target is allowed.
5. **Survive devices.** A hung home is UNCONFIRMED; others finish. A rejected command puts the fleet in reserve.
6. **Leave reserve.** Two calm, clean readings. One noisy reading resets the count.
7. **Override.** Hold the fleet or return to auto. No per-home clicking.

## Domain objects
- **Home** — one site with a battery, a reserve floor, and a live / stale / dead / unconfirmed status
- **Fleet** — all homes in one load zone, treated as one resource
- **Target** — MW ERCOT or a utility just asked for
- **Stress** — outage MW vs a published threshold, with signed margin and the driving load zone
- **Tick** — one pass: grid conditions in, validate, decide, allocate, score
- **Quality** — `ok` or the named validate failure; printed on every decision
- **Brief** — short explanation written after the tick, not used to decide

## In scope
- One load zone, one battery spec, one reserve policy
- Public ERCOT prices and NP3-233-CD outage capacity, plus an operator-selected tape
- Reserve vs target as the money loop
- Named failures and one fail-safe path
- Independent home workers with a short acknowledgment window
- Fast rules on the tick; language only to explain after
- Operator wall plus a laptop-run CLI path so the demo cannot depend on wifi alone

## Out of scope
Siting maps, billing, install crews, multi-zone expansion, real member telemetry, accounts, weather as a required signal, and any path that turns bad data into a confident NORMAL.

## Honesty
The outage threshold is a placeholder until it is backtested. Homes are simulated. Outage capacity is supply-side stress, not a storm forecast and not load. Say that on camera.

## Success
Judges can repeat: hit the target without stripping reserve, and uncertain means reserve. The demo shows both the money loop and a failure that does not look like grid risk. Next week: a real base point and real device acks.

## Pitch
Base sells power from batteries in garages. Those garages still need lights in a blackout. ReserveGate is the controller. Storm Prep is the rule that the controller may not get confident on data it cannot trust.
```