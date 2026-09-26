# Working rules

Read `docs/agents/team-manifest.md` before you edit. Touch only that person's files. One branch, one task. If the task needs a change in someone else's file, including a new dependency, setting, or shared field, stop and name the owner.

The person you are helping is new to this repo. Explain the step, then make the change. Use plain Python, short functions, and comments that say why. Keep the diff near 250 lines.

Run `pytest -q` after the change. If a test fails, fix the code and leave the test as written.

Dependencies stay `requests`, `python-dotenv`, and `pytest` unless the owner of `requirements.txt` approves another.

Secrets come only from `.env`. Do not print them, log them, or commit `.env` or `var/`.

Import shared dataclasses from `storm_prep/contracts.py`. Do not paste a second copy into another file. Fields on those types may be added. Do not rename or remove them. Ask the owner of `contracts.py` first.

`compute_risk` and `allocate` stay pure: no files, no clock, no network.

Before you drop a behavior, follow the "Never cut" and "Honest limits" sections of `docs/agents/team-manifest.md`.
