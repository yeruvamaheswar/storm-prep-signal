"""Per-tick controller emit: which batteries the controller actually moved.

Pure: no files, clock, network, or randomness. `loop.py` calls `build_tick_emit`
after `orchestrate_tick` and writes `var/fleet/tick_emit.json` itself.

Shape follows docs/agents/plans/fleet-controller-prompts.md: the whole fleet
for that tick, including homes left at 0 kW. Charge state and power come only
from confirmed kW (positive discharge, negative charge, zero holding, FULL or
EMPTY only at the rails). A home already at or under its floor is HOLDING with
assigned 0 and power 0, so a clamped order is not labeled DISCHARGING. Ack is
`ok` (confirmed) or `timeout` (unconfirmed, late, or missing). `command` is
None when the tick sent no order.
"""

from server.engine.fleet import floor_kwh

ACK_OK = "ok"
ACK_TIMEOUT = "timeout"
# Float noise from the proportional split is never a discharge.
KW_EPS = 1e-9


def charge_state(confirmed_kw, soc_kwh, capacity_kwh):
    """Charge label from confirmed kW only, never from the plan.

    FULL needs soc at capacity and EMPTY needs soc at 0; anything else at 0 kW
    is HOLDING so a writer cannot mistake a held battery for a full one.
    """
    if confirmed_kw > KW_EPS:
        return "DISCHARGING"
    if confirmed_kw < -KW_EPS:
        return "CHARGING"
    if soc_kwh >= capacity_kwh - KW_EPS:
        return "FULL"
    if soc_kwh <= KW_EPS:
        return "EMPTY"
    return "HOLDING"


def _actual_by_command(events):
    """command_id to the kW booked for it, from the tick's confirmed reports.

    A charge report is logged as `charge_confirmed` (negative kW) so delivery sums skip it;
    it is still what the home did, so a charging battery reads CHARGING, not HOLDING at 0.
    """
    actual = {}
    for event in events or []:
        if event.get("kind") in ("confirmed", "charge_confirmed") and "command_id" in event:
            actual[event["command_id"]] = float(event.get("actual_kw") or 0.0)
    return actual


def _kw_by_reassignment(events):
    """command_id to kW for `:r` children, from the tick's reassigned log lines."""
    kw = {}
    for event in events or []:
        if event.get("kind") == "reassigned" and "command_id" in event:
            kw[event["command_id"]] = float(event.get("kw") or 0.0)
    return kw


def _home_id_of(command_id):
    # "home-001:1" or "home-001:1:r". Home ids never contain a colon.
    return str(command_id).split(":")[0]


def _commands_by_home(command_states):
    """home_id to its sorted command ids, built once per tick (a charge tick sends one per home)."""
    by_home = {}
    for cid in command_states:
        by_home.setdefault(_home_id_of(cid), []).append(cid)
    return {home_id: sorted(cids) for home_id, cids in by_home.items()}


def _kw_for_command(command_id, home_id, per_home_kw, reassigned_kw):
    if str(command_id).endswith(":r"):
        return float(reassigned_kw.get(command_id, 0.0))
    return float((per_home_kw or {}).get(home_id, 0.0))


def _at_or_under_floor(home, policy):
    """True when this home has no energy it may sell. No policy means we cannot tell."""
    if policy is None:
        return False
    return home.soc_kwh <= floor_kwh(home, policy) + KW_EPS


def build_tick_emit(frame, homes, cycle, policy=None):
    """Whole-fleet emit dict for one tick. Callers JSON-dump it to tick_emit.json.

    A home already at or under its floor is written HOLDING with assigned 0 and
    power 0, even if the plan still listed it. Charge (negative kW) is left
    alone: pulling a home up toward the floor is not a discharge.
    """
    per_home_kw = dict(getattr(cycle.allocation, "per_home_kw", {}) or {})
    command_states = dict(getattr(cycle, "command_states", {}) or {})
    events = list(getattr(cycle, "events", []) or [])
    actual_by_command = _actual_by_command(events)
    reassigned_kw = _kw_by_reassignment(events)
    delivered_mw = float(getattr(cycle, "credited_mw",
                                 getattr(cycle.allocation, "delivered_mw", 0.0)) or 0.0)

    commands_by_home = _commands_by_home(command_states)
    emit_homes = {}
    for home in homes:
        home_id = home.home_id
        cids = commands_by_home.get(home_id, [])
        assigned_kw = sum(_kw_for_command(cid, home_id, per_home_kw, reassigned_kw) for cid in cids)
        # A home that only holds a reassigned child has no per_home_kw entry,
        # so fall back to its share entry when the tick sent nothing extra.
        if not cids:
            assigned_kw = float(per_home_kw.get(home_id, 0.0))
        confirmed_kw = sum(actual_by_command.get(cid, 0.0) for cid in cids
                           if command_states.get(cid) == "confirmed")
        acked = any(command_states.get(cid) == "confirmed" for cid in cids)
        power_kw = float(confirmed_kw) if acked else 0.0
        state = charge_state(float(confirmed_kw) if acked else 0.0, home.soc_kwh, home.capacity_kwh)
        # Below the floor the clamp already delivered 0, so breaches stays 0.
        # The row must not still say DISCHARGING or carry the planned kW.
        if state != "CHARGING" and _at_or_under_floor(home, policy) and (
            state == "DISCHARGING" or assigned_kw > KW_EPS or power_kw > KW_EPS
        ):
            assigned_kw = 0.0
            power_kw = 0.0
            state = "HOLDING"
            command = None
        elif not cids and float(per_home_kw.get(home_id, 0.0)) == 0.0:
            command = None
        else:
            if not cids:
                command = None
            else:
                primary = f"{home_id}:{frame.tick}" if f"{home_id}:{frame.tick}" in cids else cids[0]
                command = {
                    "command_id": primary,
                    "kw": float(assigned_kw),
                    "actual_kw": float(confirmed_kw) if acked else 0.0,
                    "ack": ACK_OK if acked else ACK_TIMEOUT,
                    "sent_at": frame.ts,
                }
        emit_homes[home_id] = {
            "soc_kwh": float(home.soc_kwh),
            "assigned_kw": float(assigned_kw),
            "power_kw": float(power_kw),
            "charge_state": state,
            "status": home.status,
            "zone": home.zone,
            "last_seen": home.updated_at or frame.ts,
            "command": command,
        }
    return {
        "tick": frame.tick,
        "ts": frame.ts,
        "target_mw": float(frame.target_mw),
        "target_label": frame.target_label,
        "delivered_mw": delivered_mw,
        "fleet_size": len(homes),
        "homes": emit_homes,
    }
