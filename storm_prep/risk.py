"""The risk rule and the battery mode rule. Pure functions only: no files, no clock, no network."""
from dataclasses import dataclass
from statistics import median

ZONES = ("South", "North", "West", "Houston")
# The three outage categories ERCOT reports for every load zone.
CATEGORIES = ("Resource", "IRR", "NewEquipResource")


def zone_fields(zone):
    return [f"total{category}MWZone{zone}" for category in CATEGORIES]


def zone_mw(row, zone):
    return sum(row[field] for field in zone_fields(zone))


def hour_total(row):
    """All 12 outage fields for one hour: 3 categories in each of 4 zones."""
    return sum(zone_mw(row, zone) for zone in ZONES)


@dataclass(frozen=True)
class RiskResult:
    level: str
    peak_mw: int
    peak_hour: int
    baseline_mw: float
    trigger_mw: float
    margin_mw: float
    driving_zone: str
    zone_mw: dict


def current_hour_index(signal):
    for index, row in enumerate(signal["rows"]):
        if (row["operatingDate"], row["hourEnding"]) == (
            signal["current_date"],
            signal["current_hour_ending"],
        ):
            return index
    # validate() (Slice 3) rejects this case before compute_risk runs.
    raise ValueError("current hour not in report")


def compute_risk(signal, margin_pct=20, lookahead_hours=6):
    """Compare the peak of the next hours against this posting's own typical level."""
    rows = signal["rows"]
    start = current_hour_index(signal)
    window = rows[start:start + lookahead_hours]
    # max() keeps the first of equal totals, so a tie always picks the earliest hour.
    peak = max(window, key=hour_total)
    peak_mw = hour_total(peak)
    baseline_mw = median([hour_total(row) for row in rows[start:]])
    # Multiply before dividing so whole-number inputs give an exact trigger (1.2 is inexact in floats).
    trigger_mw = baseline_mw * (100 + margin_pct) / 100
    zones = {zone: zone_mw(peak, zone) for zone in ZONES}
    return RiskResult(
        level="HIGH" if peak_mw >= trigger_mw else "LOW",
        peak_mw=peak_mw,
        peak_hour=peak["hourEnding"],
        baseline_mw=baseline_mw,
        trigger_mw=trigger_mw,
        margin_mw=peak_mw - trigger_mw,
        driving_zone=max(zones, key=zones.get),
        zone_mw=zones,
    )


def decide_mode(risk):
    """Slice 1 rule: HIGH risk holds the batteries in reserve. Slice 5 adds the calm streak."""
    return "RESERVE" if risk.level == "HIGH" else "NORMAL"
