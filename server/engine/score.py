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
    board["breaches"] += result.breaches
    add_dollars(board, delivered_mwh, result.price_usd_mwh, result.price_label)
    add_zones(board, result.zone_delivered_mw, hours)
    if homes is not None:
        track_lowest_soc(board, homes)
    return board


def add_dollars(board, delivered_mwh, price, label):
    """Dollars come only from priced ticks. A missing price adds nothing, never a fake $0."""
    if price is None:
        return
    board["dollars"] = (board["dollars"] or 0.0) + delivered_mwh * price
    # Keep the price source visible. If priced ticks came from different sources, say so.
    if board["dollars_label"] in ("none", label):
        board["dollars_label"] = label
    else:
        board["dollars_label"] = "mixed"


def add_zones(board, zone_delivered_mw, hours):
    """Per-zone delivered MWh. The target is fleet-wide, so zones only track delivery."""
    for zone, mw in zone_delivered_mw.items():
        entry = board["by_zone"].setdefault(zone, {"delivered_mwh": 0.0})
        entry["delivered_mwh"] += mw * hours


def track_lowest_soc(board, homes):
    """Remember the lowest charge percent any home has reached so far."""
    percents = [100 * h.soc_kwh / h.capacity_kwh for h in homes if h.capacity_kwh > 0]
    if not percents:
        return
    lowest = min(percents)
    if board["lowest_soc_pct"] is None or lowest < board["lowest_soc_pct"]:
        board["lowest_soc_pct"] = lowest
