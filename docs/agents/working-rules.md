# Working rules

Read `docs/agents/gap-work.md` before you edit. Work only the named gap. One branch, one gap. A gap may touch any file it needs. If the chat has not named a gap, name one and stop for a go-ahead.

The person you are helping is new to this repo. Explain the step, then make the change. Use plain Python, short functions, and comments that say why. Keep the diff near 250 lines.

Run `pytest -q` after the change. If a test fails, fix the code and leave the test as written.

Dependencies stay `requests`, `python-dotenv`, `pytest`, and the backend set in `CONSTRAINTS.md` ("Backend"). A new dependency is its own gap; do not add one inside another change.

Secrets come only from `.env`. Do not print them, log them, or commit `.env` or `var/`.

Import shared dataclasses from `server/engine/contracts.py`. Do not paste a second copy into another file. Fields on those types may be added. Do not rename or remove them.

`compute_risk` and `allocate` stay pure: no files, no clock, no network.

Before you drop a behavior, follow the "Never cut" and "Honest limits" sections of `docs/agents/team-manifest.md`.

Build one thin end-to-end slice at a time. Research, then plan, then implement, and stop between phases.

Start a new chat by reading `docs/agents/progress.md`. Append a short entry to it after each change.

When you add, remove, or rename a module, entry point, data file, or call between modules, update `docs/agents/code-flow.md` in the same PR, including its Mermaid diagrams, not only the text (rule: `.cursor/rules/code-flow.mdc`).

Catch network errors in one place and route every failure to `fail_safe(reason)`. Every network call has a timeout.

`compute_risk` uses the lead-matched baseline plus `RISK_MARGIN_PCT`, never an absolute MW threshold.
