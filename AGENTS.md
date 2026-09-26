# Context strategy

This file is loaded every chat. It stays a strategy for what to read and what to write down.
It does not hold the product, the team, the deadlines, or which files a person may edit. That is in `docs/agents/team-manifest.md`.

## Two shelves

`docs/agents/` is for coding agents. A file there can be any length. Open the one file the task needs. Do not open the folder and read every file.

`docs/humans/` is for people. Each file uses simple English. A person should finish it in 30 to 60 seconds. When a page needs more than that, move the detail to `docs/agents/` and leave a short pointer in `docs/humans/`.

## What to open

1. This file.
2. One file in `docs/agents/` for the task.
   - Who owns a file, what we will not cut, or what we say out loud: `docs/agents/team-manifest.md`.
   - How to edit code: `docs/agents/working-rules.md`.
   - Risk rule, event schema, past decisions: `docs/agents/plan.md`, `docs/agents/progress.md`, `docs/agents/research.md`.
3. The source files you are about to change.

Open a `docs/humans/` page only when you are writing one, or checking that a person can read it in about a minute.

If the agent file you need is missing, ask. Build the missing note with the owner. Do not fill the gap from the chat alone, and do not revive any doc that sits outside `docs/agents/` and `docs/humans/`.

## Which source wins

1. The `docs/agents/` file that covers the question.
2. The code you are editing, for behavior that is already implemented.
3. This file, for how context is read and written.
4. The current chat.

When the chat and a file disagree, re-read the file and follow it. This file wins on the strategy only. It does not win on product facts. A narrower agent file wins over a general one on the same point.

## Writing new context

Write a note before the chat ends when a later chat will need a decision, a contract, or a fact from this one.

- Add or update a file in `docs/agents/`. Name it for the topic. Put the decision first, then the detail. Any length is fine.
- When a person on the team must read it, also add `docs/humans/<topic>.md`. One topic, simple English, readable in 30 to 60 seconds. Point at the agent file for the rest.
- Leave this file unchanged unless the strategy for reading or writing context changes.
- In the chat, name the file you wrote. Do not paste the whole document.
- In the pull request, record the files touched, what `pytest -q` reported, and the path of any new context file.

When `docs/agents/` grows past a handful of files, add `docs/agents/index.md`. Give each file a title and one line that says when to open it. While choosing what to read, open the index and then one other file.

## Old notes

If you find a document that describes the retired one-run, three-battery CLI, leave it closed. Do not append to it. Current notes go in `docs/agents/` or `docs/humans/` only.
