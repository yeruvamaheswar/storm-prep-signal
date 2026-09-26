# Zone lens

**Decision.** Zone drill-in is wall state (`null` means all zones). It filters the brief, the map callout, and the Demo tape chart. It does not change the header Zone cell, which stays the driving zone. Live draws the interval strip for the fleet and does not swap that strip to zone outage MW.

Outage MW is already keyed by load zone: `houston_mw`, `north_mw`, `south_mw`, `west_mw`, or the twelve `total{category}MWZone{zone}` columns when a live stamp has them. Price is one number on the tick. A live price is `LZ_NORTH` only, so other zones show price unread. The floor on the wall tick is the fleet `reserve_pct`. `zone_reserve_pct` is not on the tape. Homes reserved and discharging are counted with the same `index % 4` rule as the map dots.

Clicking a zone polygon, a metro cluster, or its ack row selects that zone. **All zones** clears it.

The selected zone is the filled polygon. With no selection, the driving zone stays filled. The other three zones stay muted polygons. Zone names sit off the home dots. Houston’s caption can step into the gulf. Hovering a metro reads homes, reserved, discharging, supplying MW, and that zone’s outage MW. The ERCOT callout sits above the map.
