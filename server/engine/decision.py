"""The one-line summary printed at the end of every successful run."""


def format_decision(mode, risk, posted_at, now, source, quality,
                    margin_pct, lookahead_hours, clock_pinned, baseline_span):
    age_min = int((now - posted_at).total_seconds() // 60)
    parts = [
        f"[{mode}] risk {risk.level}",
        f"peak outages {risk.peak_mw:,.0f} MW at HE{risk.peak_hour} (next {lookahead_hours} h)"
        f" vs trigger {risk.trigger_mw:,.0f} MW ({risk.margin_mw:+,.0f} MW;"
        f" typical for +{risk.peak_lead} h ahead {risk.baseline_mw:,.0f} MW"
        f" over {baseline_span} postings {margin_pct:+g}%)",
        f"driving zone: {risk.driving_zone} {risk.zone_mw[risk.driving_zone]:,.0f} MW",
        f"data as of {posted_at:%H:%M} CT ({age_min} min old)",
    ]
    if clock_pinned:
        # File modes skip the real clock, so the stale check can't fire. Say so every time.
        parts.append("clock: pinned to posting")
    parts += [f"quality: {quality}", f"source: {source}"]
    return " | ".join(parts)
