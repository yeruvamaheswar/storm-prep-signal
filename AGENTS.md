# Context strategy

This file is loaded every chat. It stays a strategy for what to read and what to write down.
It does not hold the product, the team, the deadlines, or how work is chosen. Product and limits: `docs/agents/team-manifest.md`. How work is chosen: `docs/agents/gap-work.md`.

## Two shelves

`docs/agents/` is for coding agents. A file there can be any length. Do not open the folder and read every file.

`docs/humans/` is for people. Each file uses simple English. A person should finish it in 30 to 60 seconds. When a page needs more than that, move the detail to `docs/agents/` and leave a short pointer in `docs/humans/`.

## Third shelf

`CONSTRAINTS.md` and `DESIGN.md` at the repo root are frozen contracts. They are not old notes. Open `CONSTRAINTS.md` before changing behavior it names. Open `DESIGN.md` before changing the look of the wall. A note in `docs/agents/` does not override a frozen contract. A file marked later does not override `docs/agents/reservegate.md` or `CONSTRAINTS.md` on the tick, the shapes, or the invariants. File-lock lines in those older notes are not live; `docs/agents/gap-work.md` wins on how work is chosen. Narrower-wins applies only among files with the same status.

## What to open

1. This file. It is already loaded.
2. `docs/agents/index.md`.
3. If the chat has not named a gap, `docs/agents/gap-work.md`, then name one.
4. The one file whose "Open it when" line matches the task.
5. The source files you are about to change.

Open a `docs/humans/` page only when you are writing one, or checking that a person can read it in about a minute.

If the agent file you need is missing, ask. Build the missing note with the person who asked, from the end state. Do not fill the gap from the chat alone, and do not revive any doc that sits outside `docs/agents/` and `docs/humans/`.

## Which source wins

1. A frozen contract on the point it names.
2. `docs/agents/gap-work.md` on how work is chosen.
3. The `docs/agents/` file that covers the question.
4. The code you are editing, for behavior that is already implemented.
5. This file, for how context is read and written.
6. The current chat.

When the chat and a file disagree, re-read the file and follow it. This file wins on the strategy only. It does not win on product facts.

## Writing new context

Write a note before the chat ends when a later chat will need a decision, a contract, or a fact from this one.

- Add or update a file in `docs/agents/`. Name it for the topic. Put the decision first, then the detail. Any length is fine.
- When a person on the team must read it, also add `docs/humans/<topic>.md`. One topic, simple English, readable in 30 to 60 seconds. Point at the agent file for the rest.
- Leave this file unchanged unless the strategy for reading or writing context changes.
- In the chat, name the file you wrote. Do not paste the whole document.
- In the pull request, record the files touched, what `pytest -q` reported, and the path of any new context file.
- A fact has one home. Other files link to it.
- Do not paste the end state, the honest limits, or the tick order into a second file.
- If a note is superseded, replace its body with a short pointer instead of leaving two copies.
- If a path cited by a note is not in the repo, stop and ask. Do not recreate that file from the chat.

## Old notes

If you find a document that describes the retired one-run, three-battery CLI, leave it closed. Do not append to it. Current notes go in `docs/agents/` or `docs/humans/` only.
