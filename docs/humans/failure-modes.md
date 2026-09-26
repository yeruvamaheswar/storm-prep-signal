# Failure modes

You can make things go wrong on purpose, to show the fleet stays safe.

- **Bad network:** orders get lost, doubled, or arrive late.
- **Crashing homes:** a home breaks while it runs an order and goes offline.
- **Lying homes:** a home reports more (or less) power than it really gave. We catch it.

Try it: `python -m server.engine --tape tapes/failures.json`. Ticks 3, 5, 7 and 9 have faults. No battery ever goes below its floor.

Every faulted tick says `faults_injected`, so nobody mistakes a test for a real failure.

Details: `docs/agents/failure-modes.md`.
