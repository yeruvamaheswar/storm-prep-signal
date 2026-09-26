"""Tests for server/engine/channel.py: the seeded, lossy message channel."""
import pytest

from server.engine.channel import Channel
from server.engine.scheduler import Scheduler


def messages(n):
    return [{"command_id": f"home-{i:03d}:1", "kw": 1.0} for i in range(1, n + 1)]


def send_all(seed, n=20, **channel_opts):
    # Send n messages at t=0 and record (arrival time, command_id) for each delivery.
    sched = Scheduler(seed)
    channel = Channel(sched, **channel_opts)
    arrived = []
    for msg in messages(n):
        channel.send(msg, lambda m: arrived.append((sched.now, m["command_id"])))
    sched.run_until(1000.0)
    return sched, arrived


FAULTY = {"drop_rate": 0.3, "dup_rate": 0.3, "late_rate": 0.3}


# --- determinism -----------------------------------------------------------

def test_same_seed_gives_identical_events_and_delivery_order():
    sched_a, arrived_a = send_all(5, **FAULTY)
    sched_b, arrived_b = send_all(5, **FAULTY)
    assert sched_a.events == sched_b.events
    assert arrived_a == arrived_b


def test_different_seed_gives_a_different_delivery_order():
    _, arrived_a = send_all(1, **FAULTY)
    _, arrived_b = send_all(2, **FAULTY)
    assert arrived_a != arrived_b


# --- clean channel ---------------------------------------------------------

def test_clean_channel_delivers_every_message_once():
    _, arrived = send_all(3)
    ids = sorted(cid for _, cid in arrived)
    assert ids == sorted(m["command_id"] for m in messages(20))


def test_delays_fall_inside_the_range():
    _, arrived = send_all(9, n=200, delay_s=(2.0, 8.0))
    assert len(arrived) == 200
    assert all(2.0 <= t <= 8.0 for t, _ in arrived)


def test_delay_reorders_delivery():
    # Uniform delays make arrival order differ from send order: reordering for free.
    _, arrived = send_all(11, n=20)
    assert [cid for _, cid in arrived] != [m["command_id"] for m in messages(20)]


def test_same_dict_object_is_delivered_unaltered():
    sched = Scheduler(0)
    channel = Channel(sched, dup_rate=1.0)
    msg = {"command_id": "home-001:1", "kw": 2.5}
    got = []
    channel.send(msg, got.append)
    sched.run_until(1000.0)
    assert len(got) == 2 and all(m is msg for m in got)
    assert msg == {"command_id": "home-001:1", "kw": 2.5}


# --- faults ----------------------------------------------------------------

def test_drop_rate_one_delivers_nothing_and_logs_each_drop():
    sched, arrived = send_all(4, drop_rate=1.0)
    assert arrived == []
    dropped = [e for e in sched.events if e["kind"] == "dropped"]
    assert len(dropped) == 20


def test_dup_rate_one_delivers_each_message_twice_with_the_same_id():
    sched, arrived = send_all(6, dup_rate=1.0)
    counts = {}
    for _, cid in arrived:
        counts[cid] = counts.get(cid, 0) + 1
    assert counts == {m["command_id"]: 2 for m in messages(20)}
    assert sum(e["kind"] == "duplicated" for e in sched.events) == 20


def test_late_rate_one_adds_the_extra_delay():
    sched, arrived = send_all(8, delay_s=(1.0, 20.0), late_rate=1.0, late_extra_s=100.0)
    assert len(arrived) == 20
    assert all(101.0 <= t <= 120.0 for t, _ in arrived)
    assert sum(e["kind"] == "late" for e in sched.events) == 20


def test_deliveries_are_logged_with_the_command_id():
    sched, arrived = send_all(2, n=5)
    delivered = [(e["t"], e["command_id"]) for e in sched.events if e["kind"] == "delivered"]
    assert delivered == arrived


# --- bad settings ----------------------------------------------------------

@pytest.mark.parametrize("opts", [
    {"drop_rate": -0.1}, {"dup_rate": 1.5}, {"late_rate": 2.0},
    {"delay_s": (5.0, 1.0)}, {"delay_s": (-1.0, 3.0)}, {"late_extra_s": -1.0},
])
def test_bad_settings_are_rejected(opts):
    with pytest.raises(ValueError):
        Channel(Scheduler(0), **opts)


def test_message_without_command_id_is_rejected():
    channel = Channel(Scheduler(0))
    with pytest.raises(ValueError):
        channel.send({"kw": 1.0}, print)
