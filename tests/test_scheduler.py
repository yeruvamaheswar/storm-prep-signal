"""Tests for server/engine/scheduler.py: the seeded virtual clock and event queue."""
import pytest

from server.engine.scheduler import Scheduler


def run_random_script(seed):
    # A small script whose timing depends on the scheduler's rng, so two runs only
    # match if both the rng and the queue ordering are deterministic.
    sched = Scheduler(seed)

    def ping(name):
        sched.log("ping", name=name, roll=sched.rng.random())

    for i in range(10):
        sched.schedule(sched.rng.uniform(0, 50), ping, f"job-{i}")
    sched.run_until(100.0)
    return sched.events


# --- clock and rng ---------------------------------------------------------

def test_clock_starts_at_zero_and_rng_is_seeded():
    a, b = Scheduler(7), Scheduler(7)
    assert a.now == 0.0
    assert [a.rng.random() for _ in range(5)] == [b.rng.random() for _ in range(5)]


def test_same_seed_gives_identical_events():
    assert run_random_script(42) == run_random_script(42)


def test_different_seed_gives_different_events():
    assert run_random_script(1) != run_random_script(2)


# --- ordering --------------------------------------------------------------

def test_events_run_in_time_order_not_insertion_order():
    sched = Scheduler(0)
    seen = []
    sched.schedule(30.0, seen.append, "c")
    sched.schedule(10.0, seen.append, "a")
    sched.schedule(20.0, seen.append, "b")
    sched.run_until(60.0)
    assert seen == ["a", "b", "c"]


def test_ties_break_by_insertion_order():
    sched = Scheduler(0)
    seen = []
    for name in ["first", "second", "third", "fourth"]:
        sched.schedule(5.0, seen.append, name)
    sched.run_until(5.0)
    assert seen == ["first", "second", "third", "fourth"]


def test_now_equals_event_time_while_it_runs():
    sched = Scheduler(0)
    times = []
    sched.schedule(12.5, lambda: times.append(sched.now))
    sched.run_until(20.0)
    assert times == [12.5]


def test_events_scheduled_during_a_run_are_relative_to_now():
    sched = Scheduler(0)
    seen = []

    def first():
        seen.append(("first", sched.now))
        sched.schedule(5.0, lambda: seen.append(("second", sched.now)))

    sched.schedule(10.0, first)
    sched.run_until(100.0)
    assert seen == [("first", 10.0), ("second", 15.0)]


# --- run_until bound -------------------------------------------------------

def test_run_until_stops_exactly_at_the_bound():
    sched = Scheduler(0)
    seen = []
    sched.schedule(60.0, seen.append, "on_bound")
    sched.schedule(60.000001, seen.append, "past_bound")
    sched.run_until(60.0)
    assert seen == ["on_bound"]          # an event exactly at t_end runs
    assert sched.now == 60.0             # the clock lands on the bound, not past it
    sched.run_until(120.0)
    assert seen == ["on_bound", "past_bound"]
    assert sched.now == 120.0


def test_run_until_advances_the_clock_even_with_nothing_to_do():
    sched = Scheduler(0)
    sched.run_until(45.0)
    assert sched.now == 45.0


def test_run_until_never_moves_the_clock_backwards():
    sched = Scheduler(0)
    sched.run_until(50.0)
    sched.run_until(10.0)
    assert sched.now == 50.0


def test_negative_delay_is_rejected():
    sched = Scheduler(0)
    with pytest.raises(ValueError):
        sched.schedule(-1.0, print)


# --- log -------------------------------------------------------------------

def test_log_stamps_the_current_virtual_time_and_kind():
    sched = Scheduler(0)
    sched.schedule(7.0, lambda: sched.log("sent", command_id="home-001:1", kw=2.5))
    sched.run_until(10.0)
    assert sched.events == [{"t": 7.0, "kind": "sent", "command_id": "home-001:1", "kw": 2.5}]


def test_log_refuses_to_overwrite_the_time_stamp():
    sched = Scheduler(0)
    with pytest.raises(ValueError):
        sched.log("sent", t=99.0)
