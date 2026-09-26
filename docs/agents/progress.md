Storm Prep signal notes (risk rule v2). Still current for the risk rule and event schema; the ReserveGate plan is docs/agents/plan-of-attack.md.

# Progress

## 2026-09-25: Slice 0, research and plan (no application code)

- Wrote `docs/research.md`. It covers NP3-233-CD access, auth (id_token as a Bearer token,
  plus the `Ocp-Apim-Subscription-Key` header), the endpoint and its parameters, the 15
  response fields, the hour to rate, the posted time, and a real trimmed sample.
- Verified with one read-only live call using the `.env` credentials. The token and data
  calls returned 200, and a request without a token returned 401. The call came from a
  throwaway script in `/tmp`, which was deleted. No secrets were printed.
- Key facts:
  - There is **no total field**. The total is the sum of 12 per-zone MW fields.
  - Today's total is about 19,500 MW, so `RISK_THRESHOLD_MW=5000` would always rate HIGH.
- Wrote `docs/plan.md`: slices 0–6 plus V, the function names, the event schema, and a
  mermaid data-flow diagram. Status: DRAFT, waiting for approval.
- `.gitignore` and `.env.example` were already correct from setup and were left unchanged.
- Not verified: the narrower single-hour query (not needed; the plan uses the verified query).
- Next: the owner answers the 5 open questions in `docs/plan.md` and approves the plan.
  Then Slice 1 (the fixture happy path) can start.

## 2026-09-25: Slice 0, owner decisions recorded (docs only)

- Decided:
  - The total is Resource + IRR + NewEquip across the 4 zones, and the driving zone is the
    zone with the largest sum.
  - We rate the current hour from the newest posting.
  - Python is 3.13 (`AGENTS.md` updated from 3.11).
  - `JEV_API_KEY` is optional and never required (marked in `.env.example`).
- Approved: the A/R/S rules (R = exactly one more fetch + validate; S = keep RESERVE and end;
  no answer = stay RESERVE, exit 2), the 90-minute staleness limit, and the fixture clock
  pinned to the posted time. The owner called the A/R/S section "Slice 3"; it is in
  plan Slice 2.
- Added to the plan: `RISK_THRESHOLD_MW` is always read from config and the code has no
  built-in value. If it is missing or not a number, the run fails safe.
- Still open: the threshold approach (on hold, the owner will send it).
- Next: wait for the threshold approach. Slice 1 has not started.

## 2026-09-25: Slice 1 decisions recorded, step 0 fixture check (no app code)

- Updated `docs/plan.md`, `AGENTS.md`, `docs/research.md` and `.env.example`:
  - The risk rule is now a relative trigger: `compute_risk(signal, margin_pct=20, lookahead_hours=6)`.
  - `RISK_MARGIN_PCT` and `LOOKAHEAD_HOURS` replace `RISK_THRESHOLD_MW` (removed).
  - Also recorded: the decision line, the validation reasons, auth, and the no-secrets-in-logs test.
- Saved the real response to `tests/fixtures/np3_233_cd.json`. It is one posting
  (`2026-09-25T12:00:47`) with 192 rows. It contains only the JSON body, and a self-check
  found no secret substrings.
- Branch A was chosen under both readings of "hours 1–168". Which 168 rows to use for the
  baseline is open for the owner. The numbers are in `docs/plan.md`.
- Fixture result: peak 22,194 MW at HE15, driving zone North, level LOW (margin about −400 MW).
- Next: the owner picks the baseline rows. Slice 1 has not started.

## 2026-09-25: Third-round decisions recorded (docs only)

- Baseline = the median `hour_total` from the current hour through the end of the posting.
  Validation needs at least 48 rows from the current hour on. On the real fixture that is
  179 rows: baseline 18,623 MW, trigger 22,347.6 MW, peak 22,194 MW at HE15, risk LOW.
- New slice order:
  - 1: fixture tracer bullet, plus the synthetic spike fixture that must rate HIGH.
  - 2: live fetch and auth, plus the no-secrets test.
  - 3: `validate`, `fail_safe`, A/R/S, and `--simulate`.
- Approved: the `current hour not in report` reason.
- Added `format_decision` to the `AGENTS.md` names.
- The agent proposed three things that the owner should confirm:
  - A small pure helper `to_signal`, because Slice 1 has no `validate`.
  - Pinning the clock for `--file` as well as `--fixture`.
  - A minimal `fail_safe` in Slice 2, so live errors go to RESERVE.
- Next: owner confirmation. Slice 1 has not started.

## 2026-09-25: Slice 1 done, fixture tracer bullet (not committed)

- Built the `storm_prep` package:
  - `signal.py`: `load_signal` and `to_signal`.
  - `risk.py`: `compute_risk`, `RiskResult` and a simple `decide_mode`.
  - `batteries.py`: `apply_to_batteries`.
  - `decision.py`: `format_decision`.
  - `events.py`: `log_event`, writing `var/logs/<run_id>.jsonl`.
  - `__main__.py`: the CLI, with `--fixture` and `--file`.
  - Also added `pytest.ini`.
- Added `tests/fixtures/np3_spike_synthetic.json`: the real fixture plus 500 MW on
  `totalResourceMWZoneHouston` at 2026-09-25 HE16 (2745 → 3245), labeled in `_note`.
- `pytest -q`: 6 passed. The tests cover:
  - The `>=` boundary (HIGH), 1 MW below (LOW), and a peak at hour 6 of the window.
  - The real fixture gives the same line on every run and gets one log file per run.
  - The synthetic spike gives HIGH and RESERVE.
  - Every stage is logged.
- A mutation check (`>` instead of `>=`) makes the boundary test fail, as it should.
- Real fixture line: `[NORMAL] risk LOW | peak outages 22,194 MW at HE15 ... (-154 MW; week median 18,623 MW +20%) | driving zone: North 9,429 MW | ... | clock: pinned to posting | quality: unchecked | source: fixture`.
- Synthetic line: `[RESERVE] risk HIGH | peak outages 22,539 MW at HE16 ... (+191 MW; ...) | driving zone: North 9,294 MW | ... | source: fixture (synthetic)`.
- Choices made during the slice:
  - The line says `quality: unchecked` until `validate()` exists (Slice 3), so it doesn't
    claim checks that never ran.
  - `run_id` now includes microseconds. Two runs in the same second had shared one log
    file; this was found and fixed during the slice.
  - `decide_mode(risk)` takes no state yet (Slice 5 adds it).
- Size: 273 lines of app code (including docstrings and comments) plus 86 lines of tests.
  That is slightly over the ~250 budget.
- Next: Slice 2 (live fetch, auth, minimal `fail_safe`, no-secrets test). Not started.

## 2026-09-25: Slice 1b done, risk rule v2 (not committed)

- Why: rule v1 compared the next 6 h with the median of the rest of the posting. Scheduled
  outages shrink with lead time, so that median was structurally low, and v1 rated HIGH on
  666 of 755 real postings (Aug 25-Sep 25 2026).
- Rule v2: each window hour is compared with the typical total at the same lead time across
  past postings. The hour with the largest ratio is the peak, and `peak_lead` was added to
  `RiskResult` (added, nothing renamed).
- New files:
  - `data/baseline_by_lead.json`: 755 postings, medians for leads 0-5. Committed on purpose.
  - `scripts/make_baseline.py <csv_folder>`: rebuilds that file from MIS CSVs (stdlib only).
  - `storm_prep/baseline.py`: `load_baseline` (named errors when the file is missing or too
    short) and `baseline_span`.
- `compute_risk(signal, baseline, margin_pct=15, lookahead_hours=6)`. `run()` logs a new
  `load_baseline` stage. The decision line now says `typical for +N h ahead ... over Aug 25-Sep 25 postings`.
- `RISK_MARGIN_PCT` default is now 15. The 15% was calibrated on Aug 25-Sep 25 2026 data
  (1.7% out-of-sample HIGH rate). It is **unvalidated against real stress events**: Winter
  Storm Uri (Feb 2021) and Elliott (Dec 2022) were not tested.
- The synthetic spike is now +1500 MW (2745 -> 4245 at Houston HE16), because +500 MW no
  longer crosses the v2 trigger.
- `pytest -q`: 9 passed. A mutation check (`>` instead of `>=`) failed both boundary tests.
  `make_baseline.py` was smoke-tested on three hand-made CSVs, not on the real 755 files.
- Real fixture line: `[NORMAL] risk LOW | peak outages 22,194 MW at HE15 (next 6 h) vs trigger 23,304 MW (-1,110 MW; typical for +2 h ahead 20,264 MW over Aug 25-Sep 25 postings +15%) | ...`.
- The owner's local `.env` still had `RISK_MARGIN_PCT=20`. The agent did not edit `.env`.
- Next: Slice 2 (live fetch). Not started.
