# Storm Prep strip

The wall's second strip shows the outage posting behind HIGH or LOW. It does not decide the floor.

A tick is used as written when it carries `outage_mw`, `threshold_mw`, `margin_mw`, and `driving_zone`. Optional companions are `zone_mw`, `stress_as_of`, `stress_age_min`, `stress_quality`, and `clock_pinned`.

Otherwise the 12-tick tape (and the wall scenes) carry `houston_mw`, `north_mw`, `south_mw`, and `west_mw`. Outage MW is their sum. Tick 05 is the synthetic spike: Houston 3,927, North 9,294, South 4,864, West 4,454, total 22,539 versus trigger 22,348, margin +191 MW. LOW ticks use the calm posting: Houston 3,427, North 9,429, South 4,864, West 4,474, total 22,194, under the line. Driving zone is the largest of those four. Quality stays `unchecked` until a check exists. The clock is pinned, so that age is not a live staleness claim. `signal_unavailable` shows no megawatts.

The zone map reads the same four columns. A tick that already carries `total{category}MWZone{zone}` for all twelve NP3 columns is drawn from those numbers instead. Missing zone columns mute the map. There is no painted-spike fallback.
