# Epics: what is left between the repo and the end state

**Decision (2026-09-26).** The remaining work is grouped into nine epics. An epic is an area of the gap, not a work queue. Work is still chosen one gap at a time by `docs/agents/gap-work.md`: pick an epic, name the one smallest gap inside it, fill it. The end state is the Outcome and Success sections of `docs/agents/reservegate-summarized.md`. People page: `docs/humans/epics.md`.

Checked against the code on 2026-09-26. The code-level list of stubs is `docs/agents/code-flow.md`, section "Stubs and gaps"; this file groups those stubs by what the product still cannot do. When an epic is done, mark it done here and on the people page, and add a progress entry.

## Already built (do not reopen without a gap)

- Storm rule v2 on live and archived NP3-233-CD, stale check, fail-safe to the 60% floor. `server/engine/risk.py`, `signal.py`, `policy.py`.
- Allocator, fleet, second floor check, `allocate` wired into `loop.py`. `controller.py`, `fleet.py`.
- Orchestration runtime and proof run (`FUZZ_SEEDS=50`: 600 ticks, 0 floor breaches). Separate runner only. `orchestration.py` (`orchestrate_tick`), `docs/agents/epic-3-controller.md`.
- ERCOT auth behind the Python proxy, live price at LZ_NORTH, laptop live worker. `feeds-proxy.md`, `price-live.md`, `live-ingest.md`.
- Wall: Live / Demo / archive modes, one snapshot for the header, Quality and Reports drawer, zone drill-in, ack rollup bars, interval strip, Hold/Auto writing `var/state.json`.
- Supabase archive of Beryl, Heather and tuning-2026; archive snapshots rated by `compute_risk`; `persist_run.py` behind `--persist`.
- Heather replay tape: the floor rises to 60% only after the 13:03 posting (`tapes/heather.json`, `scripts/build_tape.py`).
- Epic 7, charging (done 2026-09-26). Signed charge per `CONSTRAINTS.md` allocation step 6: the worker clamps to room below capacity, charge is booked in `charging_mw` apart from delivery, and `breaches == 0` holds (`FUZZ_SEEDS=50`). A home under its floor refills to it at any price (`CONSTRAINTS.md` allocation step 10); filling past the floor is price-only (at or below `CHARGE_BELOW_USD`). Grid-down zones neither sell nor charge (allocation step 7). Shown on `/flow`: `grid-flow.md`.
- Epic 7, look-ahead charging (filled 2026-09-27 for recorded tapes and Live). With a zone's ERCOT DAM hours on the tick, a battery above its floor charges in the zone's cheapest upcoming DAM hours (as many as the zone needs to fill), on a real-time dip, and only when a later hour pays back the round trip. Selling and refill to the floor are unchanged; no DAM falls back to the $25/$60 bands. Tapes carry recorded NP4-190-CD days (`TapeFrame.dam_fixtures`); Live fetches them once a day into `var/dam/`, and the Live wall shows the next 24 hours. Rule and evidence: `policy-intent.md` "Cheapest DAM hours". Open finding, pending the user: the `heather-spike` replay nets about $198 less, because the zone waits past a real dip for a cheaper hour beyond the price spike. Panel and data: `dam-forecast.md`.

## Open epics

Order is rough value toward the one-minute judge story, not a required sequence.

### 1. Leave reserve on two calm readings (engine)
- Gap: the calm streak lives only on the wall (`web/src/calmStreak.ts`). `decide_mode` in `server/engine/risk.py` is stateless ("Slice 5 adds the calm streak"). The engine can drop the floor after one LOW.
- Filled: a tick after one clean LOW stays RESERVE; the second clean LOW returns to NORMAL; one noisy reading resets the count. Engine test plus the streak on `TickResult` (add-only).
- End state: Outcome step 5, Core flow 6.

### 2. Bad data asks a person: approve, retry once, skip
- Gap: `POST /v1/attention/{id}` in `server/api/v1.py` answers attention items held in memory from the console fixtures. The engine does not raise one when a feed fails, and a retry does not refetch.
- Filled: a named live failure (auth, timeout, stale, malformed) opens an attention item on the snapshot; retry refetches exactly once; skip keeps RESERVE; no answer keeps RESERVE.
- End state: Core flow 4.

### 3. Score the run
- Gap: `score.py` (`new_board`, `update`) exists, but `loop.py` writes `"totals": {}`.
- Filled: the run file and snapshot carry delivered vs target, missed with reason, dollars (None without a price), breaches, per zone. The wall shows the totals line.
- End state: Outcome step 6.

### 4. Engine uses the orchestration runtime
- Gap: `loop.py` calls `allocate` then `discharge`, with acks from `supervisor.simulate_zone_acks`. `orchestrate_tick` (timeouts, retries, unconfirmed MW) only runs from its own CLI.
- Filled: the engine calls `orchestrate_tick`; `TickResult` carries planned / confirmed / unconfirmed MW (add-only); unconfirmed never counts as delivered on screen or in the brief.
- End state: Outcome step 4, Core flow 5. Contract words: `epic-3-controller.md`, "Same words for the same numbers".

### 5. Storm rule that catches a real storm
- Gap: at +15% the rule rated LOW on every Beryl posting and HIGH on one Heather posting (`scripts/check_margin.py`). The per-zone weather path exists in `reserve_policy(..., alerted=)`, but `loop.py` never passes `alerted` or reads `TapeFrame.weather_fixture`.
- Filled: a weather-alert source feeds `alerted` on a tick, and a Beryl replay raises at least the Houston floor. Any margin change is an engine decision recorded in `progress.md`.
- End state: Honesty section (threshold is a placeholder until backtested).
- Partly filled (2026-09-26): on `/flow` an operator can send a real archived NWS alert (for Beryl, the Harris Tropical Storm Warning) and the Houston floor rises from the next tick (`grid-flow.md`). The main tick loop still has no alert source of its own.

### 6. Every screen reads the engine
- Gap: `/live`, `/zone`, `/homes`, `/ticks`, `/tapes`, and the `/live/stream` tick event still read `web/src/fixtures/console/*.json`. The `features/` console pages render preview data. The run record has no `decision_line`.
- Filled: those routes serve the latest run or snapshot, and no operator-facing number comes from a console fixture.
- End state: Core flow 1 (Watch).

### 7. Charging: base done 2026-09-26; look-ahead filled 2026-09-27 for recorded tapes and Live
- Base and look-ahead: see "Already built" above. The text below is the gap as it was named, kept for the record.
- Gap: a battery charges past its floor only when the zone's current price is at or below `charge_threshold_usd_mwh` (`CONSTRAINTS.md` allocation step 8, `policy.price_band`). Nothing looks ahead: it charges at $24 even when $5 comes in two hours, and waits at $26 even when every later hour costs more (`grid-flow.md` limits and "Scenarios"; in `price-spike` the fleet is empty by the $1,000 peak). ERCOT's Day-Ahead Market (DAM) settlement point prices are posted the day before, hourly, per load zone (report NP4-190-CD, named out of scope in `price-live.md` "Not this pass"). No code, Supabase table, or tape carries them today.
- Wanted (user): each zone charges in its cheapest upcoming DAM hours and skips charging when a cheaper hour is coming.
- Filled: with a zone's DAM hours on the tick (live fetch, or recorded on the tape), a battery above its floor skips a cheap real-time hour when a cheaper DAM hour comes later in the window, and charges in the cheapest DAM hours. Refill to the floor at any price (allocation step 10) is never delayed by DAM. Missing DAM data falls back to today's threshold rule. One test per case, plus a replay showing where charge moved.
- End state: Outcome step 2 ("Price moves; only surplus energy is sold") and In scope ("Reserve vs target as the money loop"). The rule change lands in `CONSTRAINTS.md` and `policy-intent.md` with the gap; fields add-only.

### 8. Demo that runs without wifi
- Gap: no `demo.sh`. `load_tape` in `loop.py` is still TEMP and does not check labels or offsets. `tapes/` is untracked in git. No fault frames (dead zone, straggler, duplicate, split floors).
- Filled: one laptop command plays a saved ERCOT replay through the engine, prints the proof line, and the wall follows it with the network off.
- End state: In scope ("laptop-run CLI path"), `PROJECT_CONTEXT.md` principle 5.

### 9. Ship
- Gap: the API is not deployed to Render; the wall has no deployed host; no Loom.
- Filled: deployed wall and API talk (`api ok` in the mast), README states the honest limits from `team-manifest.md`, Loom follows the six Outcome beats. Code freeze Sun 9:30 AM CT, submit 10:30 AM.
