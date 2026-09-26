"""The running scoreboard. The engine writes the board into `totals` in the run file.

The board is a plain dict of numbers, strings and None so json.dumps can write it as is.
"""
import copy

DEFAULT_TICK_MINUTES = 5


def new_board(settings=None):
    """An empty board. tick_minutes is stored on it so update() can turn MW into MWh."""
    settings = settings or {}
    return {
        "tick_minutes": settings.get("tick_minutes", DEFAULT_TICK_MINUTES),
        "ticks": 0,
        "target_mwh": 0.0,
        "delivered_mwh": 0.0,
        "missed_mwh": 0.0,
        # None until some target is asked for; 0% of nothing is not a score.
        "delivery_pct": None,
        "hold_ticks": 0,
        # None, not 0.0: until a priced tick arrives we do not know the dollars.
        "dollars": None,
        "dollars_label": "none",
        "breaches": 0,
        # None until update() is given the homes; a guess here would mislead the screen.
        "lowest_soc_pct": None,
        "by_zone": {},
    }


def update(board, result, homes=None):
    """Add one TickResult to the board and return the new board.

    The board passed in is left unchanged, so a caller can keep the previous totals.
    """
    board = copy.deepcopy(board)
    hours = board["tick_minutes"] / 60
    delivered_mwh = result.delivered_mw * hours

    board["ticks"] += 1
    board["target_mwh"] += result.target_mw * hours
    board["delivered_mwh"] += delivered_mwh
    board["missed_mwh"] += result.missed_mw * hours
    if board["target_mwh"] > 0:
        board["delivery_pct"] = 100 * board["delivered_mwh"] / board["target_mwh"]
    board["hold_ticks"] += result.mode == "HOLD"
    board["breaches"] += result.breaches
    zone_usd = zone_priced_dollars(result, hours)
    if zone_usd is None:
        add_dollars(board, delivered_mwh, result.price_usd_mwh, result.price_label)
    else:
        add_usd(board, zone_usd, result.zone_price_label)
    add_zones(board, result, hours)
    if homes is not None:
        track_lowest_soc(board, homes)
    return board


def add_dollars(board, delivered_mwh, price, label):
    """Dollars come only from priced ticks. A missing price adds nothing, never a fake $0."""
    if price is None:
        return
    add_usd(board, delivered_mwh * price, label)


def add_usd(board, usd, label):
    """Add known dollars to a board (or a zone entry) and keep its price label honest."""
    board["dollars"] = (board["dollars"] or 0.0) + usd
    # Keep the price source visible. If priced ticks came from different sources, say so.
    if board["dollars_label"] in ("none", label):
        board["dollars_label"] = label
    else:
        board["dollars_label"] = "mixed"


def zone_priced_dollars(result, hours):
    """This tick's dollars summed over zones at each zone's own price, so the fleet figure
    matches the zones. A zone-priced tick that delivered nothing is $0 under the zone label.
    None when the tick has no zone prices or a delivering zone has none: then the fleet
    figure uses the tick's one price, as before.
    """
    delivering = {zone: mw for zone, mw in result.zone_delivered_mw.items() if mw > 0}
    if not result.zone_prices or any(result.zone_prices.get(zone) is None for zone in delivering):
        return None
    return sum(mw * hours * result.zone_prices[zone] for zone, mw in delivering.items())


def add_zones(board, result, hours):
    """Per-zone delivered MWh, and dollars at that zone's own price. The target is fleet-wide.

    A zone with no price this tick adds no dollars. It never borrows another zone's price.
    """
    for zone, mw in result.zone_delivered_mw.items():
        entry = board["by_zone"].setdefault(
            zone, {"delivered_mwh": 0.0, "dollars": None, "dollars_label": "none"})
        entry["delivered_mwh"] += mw * hours
        add_dollars(entry, mw * hours, result.zone_prices.get(zone), result.zone_price_label)


def track_lowest_soc(board, homes):
    """Remember the lowest charge percent any home has reached so far."""
    percents = [100 * h.soc_kwh / h.capacity_kwh for h in homes if h.capacity_kwh > 0]
    if not percents:
        return
    lowest = min(percents)
    if board["lowest_soc_pct"] is None or lowest < board["lowest_soc_pct"]:
        board["lowest_soc_pct"] = lowest
