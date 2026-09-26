# Archived grid numbers

Demo and Synthetic do not call today’s ERCOT. They look up the saved posting and the North price for the tape’s clock. The reserve floor still comes from the same storm rule as Live (`compute_risk`), not a fixed 22,348 MW line.

Live reads the newest `event=live` row the laptop worker wrote. Direct ERCOT is only the fallback. The two history tables are not wiped when a tape resets.

More: `docs/agents/archive-feeds.md`.
