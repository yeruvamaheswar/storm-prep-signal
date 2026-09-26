# Floor and risk

The reserve floor moves when the storm rule says HIGH, or when the outage report cannot be read. HIGH, or a missing report, keeps 60% backup. LOW keeps 30%.

The number the wall compares outage MW to is the v2 trigger: typical outages for that lead time, plus 15%. It is not a fixed 22,348 MW line. Live and archive both get that number from `compute_risk`. Archive reads the saved `ercot_postings` row. A missing posting holds 60% backup.

If the report is late or missing, Quality says so and the banner holds the floor. Live does not fill those cells with the demo tape.

The long note is `docs/agents/stress-strip.md` and `docs/agents/wall-snapshot.md`.
