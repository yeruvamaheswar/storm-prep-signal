"""Tests for server/engine/score.py: the running scoreboard that fills `totals` in the run file."""
import copy
import json

import pytest

from server.engine.contracts import Home, TickResult
from server.engine.score import new_board, update


def tick(n, target, delivered, price=50.0, label="synthetic", breaches=0, zones=None, mode="AUTO"):
    # A TickResult with only the fields the scoreboard reads set to interesting values.
    return TickResult(
        tick=n, ts=f"2026-02-01T00:{n * 5:02d}:00-06:00", mode=mode,
        target_mw=target, target_label="synthetic",
        delivered_mw=delivered, missed_mw=max(0.0, target - delivered),
        price_usd_mwh=price, price_label=label,
        reserve_pct=30.0, policy_reason="normal", risk_level="LOW",
        live_homes=100, stale_homes=0, dead_homes=0,
        breaches=breaches, zone_delivered_mw=zones or {},
    )


# --- new_board -------------------------------------------------------------

def test_new_board_starts_empty():
    board = new_board()
    assert board["ticks"] == 0 and board["breaches"] == 0
    assert board["target_mwh"] == 0.0 and board["delivered_mwh"] == 0.0 and board["missed_mwh"] == 0.0
    # No price seen yet, so no dollar figure yet (never a made-up $0).
    assert board["dollars"] is None and board["dollars_label"] == "none"
    assert board["lowest_soc_pct"] is None and board["by_zone"] == {}
    assert board["delivery_pct"] is None and board["hold_ticks"] == 0
    assert board["tick_minutes"] == 5


def test_new_board_reads_tick_minutes_from_settings():
    assert new_board({"tick_minutes": 15})["tick_minutes"] == 15


# --- update ----------------------------------------------------------------

def test_three_tick_example_adds_up_by_hand():
    # 5-minute ticks, so each MW held for one tick is 5/60 = 1/12 MWh.
    board = new_board({"tick_minutes": 5})
    board = update(board, tick(1, target=0.6, delivered=0.6, price=60.0, breaches=0))
    board = update(board, tick(2, target=1.2, delivered=0.6, price=120.0, breaches=0))
    board = update(board, tick(3, target=0.0, delivered=0.0, price=30.0, breaches=0))
    assert board["ticks"] == 3
    assert board["target_mwh"] == pytest.approx(1.8 / 12)     # 0.15
    assert board["delivered_mwh"] == pytest.approx(1.2 / 12)  # 0.10
    assert board["missed_mwh"] == pytest.approx(0.6 / 12)     # 0.05
    # 0.05 MWh x $60 + 0.05 MWh x $120 + 0 = $3 + $6 = $9
    assert board["dollars"] == pytest.approx(9.0)
    assert board["dollars_label"] == "synthetic"
    assert board["breaches"] == 0


def test_delivery_pct_is_cumulative_delivered_over_target():
    board = update(new_board(), tick(1, target=0.0, delivered=0.0))
    assert board["delivery_pct"] is None
    board = update(board, tick(2, target=0.6, delivered=0.6))
    board = update(board, tick(3, target=0.6, delivered=0.0))
    assert board["delivery_pct"] == pytest.approx(50.0)


def test_hold_ticks_count_operator_hold():
    board = new_board()
    board = update(board, tick(1, 0.4, 0.4))
    board = update(board, tick(2, 0.4, 0.0, mode="HOLD"))
    board = update(board, tick(3, 0.4, 0.0, mode="HOLD"))
    assert board["hold_ticks"] == 2


def test_breaches_add_up():
    board = new_board()
    board = update(board, tick(1, 0.1, 0.1, breaches=2))
    board = update(board, tick(2, 0.1, 0.1, breaches=1))
    assert board["breaches"] == 3


def test_tick_minutes_changes_mwh():
    board = update(new_board({"tick_minutes": 15}), tick(1, target=1.0, delivered=1.0, price=None))
    assert board["delivered_mwh"] == pytest.approx(0.25)


def test_none_price_gives_none_dollars():
    board = new_board()
    board = update(board, tick(1, 0.5, 0.5, price=None, label="none"))
    board = update(board, tick(2, 0.5, 0.5, price=None, label="none"))
    assert board["dollars"] is None
    assert board["dollars_label"] == "none"
    assert board["delivered_mwh"] == pytest.approx(1.0 / 12)


def test_unpriced_tick_adds_nothing_then_priced_tick_starts_dollars():
    board = new_board()
    board = update(board, tick(1, 1.2, 1.2, price=None, label="none"))
    board = update(board, tick(2, 1.2, 1.2, price=100.0, label="recorded:ercot"))
    board = update(board, tick(3, 1.2, 1.2, price=None, label="none"))
    # Only tick 2 is priced: 0.1 MWh x $100.
    assert board["dollars"] == pytest.approx(10.0)
    assert board["dollars_label"] == "recorded:ercot"


def test_lowest_charge_only_when_homes_passed():
    board = update(new_board(), tick(1, 0.1, 0.1))
    assert board["lowest_soc_pct"] is None
    homes = [Home("home-001", 20.0, 9.0, 5.0), Home("home-002", 20.0, 15.0, 5.0)]
    board = update(board, tick(2, 0.1, 0.1), homes=homes)
    assert board["lowest_soc_pct"] == pytest.approx(45.0)
    # A later tick with fuller homes does not raise the lowest-ever figure.
    board = update(board, tick(3, 0.1, 0.1), homes=[Home("home-001", 20.0, 18.0, 5.0)])
    assert board["lowest_soc_pct"] == pytest.approx(45.0)
    # A tick without homes leaves it alone.
    board = update(board, tick(4, 0.1, 0.1))
    assert board["lowest_soc_pct"] == pytest.approx(45.0)


def test_by_zone_sums_delivered_per_zone():
    board = new_board()
    board = update(board, tick(1, 0.6, 0.6, zones={"Houston": 0.24, "North": 0.36}))
    board = update(board, tick(2, 0.6, 0.6, zones={"Houston": 0.12, "West": 0.48}))
    assert set(board["by_zone"]) == {"Houston", "North", "West"}
    assert board["by_zone"]["Houston"]["delivered_mwh"] == pytest.approx(0.36 / 12)
    assert board["by_zone"]["North"]["delivered_mwh"] == pytest.approx(0.36 / 12)
    assert board["by_zone"]["West"]["delivered_mwh"] == pytest.approx(0.48 / 12)


def test_update_does_not_change_the_board_passed_in():
    board = new_board()
    before = copy.deepcopy(board)
    update(board, tick(1, 0.5, 0.5, zones={"Houston": 0.5}), homes=[Home("h", 20.0, 10.0, 5.0)])
    assert board == before


def test_board_is_json_serializable():
    board = update(new_board(), tick(1, 0.5, 0.4, zones={"Houston": 0.4}), homes=[Home("h", 20.0, 10.0, 5.0)])
    assert json.loads(json.dumps(board)) == board
