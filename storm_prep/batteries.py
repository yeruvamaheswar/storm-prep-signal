"""Three simulated batteries. Slice 4 adds hung and failing batteries."""

BATTERY_IDS = ("battery-1", "battery-2", "battery-3")


def new_batteries():
    return {battery_id: "NORMAL" for battery_id in BATTERY_IDS}


def apply_to_batteries(mode, batteries):
    """Set every battery to `mode` and return which ones acknowledged."""
    acks = {}
    for battery_id in batteries:
        batteries[battery_id] = mode
        acks[battery_id] = True
    return acks
