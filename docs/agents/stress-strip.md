# Storm Prep strip

The wall's second strip shows the outage posting behind HIGH or LOW. It does not decide the floor.

Margin on that strip is outage MW minus the reserve threshold (`22,539 − 22,348 = +191` on tick 05). A positive margin is "past the reserve threshold". That is not spare fleet energy. Delivered MW is "above the {floor}% floor". Margin and the outage trigger come from `web/src/wallLines.ts`. The banner under the strip is the fleet intent line. When the posting is past the threshold, that line includes this same trigger. The sentence lives in `docs/agents/fleet-intent.md`.

The reserve threshold is `trigger_mw` from `compute_risk` (lead-matched baseline × 1.15). The wall does not invent `22348`. Live `GET /v1/snapshot` sends `trigger_mw`, `peak_mw`, `outage_mw` (the peak hour), the twelve NP3 zone columns, and `margin_mw = outage − trigger`. `threshold_mw` is the same number as `trigger_mw` so old readers still work.

A tick is used as written when it carries `outage_mw`, `trigger_mw` or `threshold_mw`, `margin_mw`, and `driving_zone`. Optional companions are `zone_mw`, `stress_as_of`, `stress_age_min`, `stress_quality`, and `clock_pinned`.

Otherwise the 12-tick tape (and the wall scenes) carry `houston_mw`, `north_mw`, `south_mw`, `west_mw`, and `trigger_mw`. Outage MW is their sum. Tick 05 is the synthetic spike: Houston 3,927, North 9,294, South 4,864, West 4,454, total 22,539 versus the tape's `trigger_mw` 22,348, margin +191 MW. LOW ticks use the calm posting: Houston 3,427, North 9,429, South 4,864, West 4,474, total 22,194. Driving zone is the largest of those four. Quality stays `unchecked` until a check exists. The clock is pinned, so that age is not a live staleness claim. `signal_unavailable` shows no megawatts. Zone columns without a trigger show outage MW and no threshold.

The header tiles, including Quality and As of, read the snapshot in `docs/agents/wall-snapshot.md`. Demo may show Demo data or Unchecked. Live QUALITY is only Live, Stale, Auth error, or Degraded. AS OF in Live is feed lag, not "clock pinned", unless the operator pins.

The zone map reads the same four columns. A tick that already carries `total{category}MWZone{zone}` for all twelve NP3 columns is drawn from those numbers instead. Missing zone columns mute the map. There is no painted-spike fallback.
