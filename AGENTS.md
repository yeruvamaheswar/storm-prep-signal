# Storm Prep Signal: rules for the coding agent

Project: Python 3.11 CLI. Reads the ERCOT NP3-233-CD outage capacity report, rates risk HIGH/LOW,
sets 3 simulated batteries to RESERVE/NORMAL. Every uncertain path goes to fail_safe(reason):
all batteries RESERVE, reason logged, human prompt Approve/Retry/Skip (A/R/S), one bounded retry.
Returning to NORMAL needs two calm readings in a row.

Names to use exactly: load_signal, fetch_outages, validate, compute_risk(signal, threshold),
decide_mode, apply_to_batteries, fail_safe(reason).
Flags: --fixture, --file, --simulate timeout, --simulate poison, --hang-battery, --fail-battery.
Optional command: view <logfile> (replay viewer, slice V).
Every stage logs through log_event(...) in storm_prep/events.py. The event schema is in
docs/plan.md; fields are only ever added, never renamed.

Rules:
- The owner is a beginner. Plain Python, short functions, clear names, comments that explain why.
  Dependencies: requests, python-dotenv, pytest only, unless I approve more.
- Build tracer bullets: one thin end-to-end slice at a time. Do not build ahead of the current slice.
- Work in three phases and stop between them: RESEARCH (read only, write docs/research.md),
  PLAN (write docs/plan.md, wait for approval), IMPLEMENT (only the approved plan, then append
  a short entry to docs/progress.md).
- Start every new chat by reading docs/progress.md; it is the compacted memory of the project.
- Keep diffs under ~250 lines per slice.
- No scattered try/except. Network errors are caught in one place in fetch_outages and turned
  into data that validate() names. All failures route to fail_safe(reason).
- compute_risk and decide_mode stay pure: no I/O, no clock, no network.
- Every network call has a timeout. In live mode, never fall back to fixture data.
- Secrets only from .env. Never print or log them. Never commit .env or var/.
- Run `pytest -q` after implementing. Do not edit or weaken tests to make them pass.
- Stop and ask instead of guessing when the plan is ambiguous.