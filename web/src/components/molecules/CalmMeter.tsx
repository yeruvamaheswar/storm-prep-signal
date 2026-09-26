import { CALM_LINE, CALM_NEEDED } from "../../calmStreak"

type CalmMeterProps = {
  streak: number
}

/** 0–2 fill between the metric number and its caption, so a zero still reads as a meter. */
export function CalmMeter({ streak }: CalmMeterProps) {
  const value = Math.max(0, Math.min(streak, CALM_NEEDED))
  const empty = value === 0
  const full = value >= CALM_NEEDED
  const tone = full ? "ok" : "ink"
  return (
    <div
      className={empty ? "calm-meter is-zero" : "calm-meter"}
      role="meter"
      aria-label="Calm readings"
      aria-valuemin={0}
      aria-valuemax={CALM_NEEDED}
      aria-valuenow={value}
      aria-valuetext={`${String(value)} of ${String(CALM_NEEDED)}. ${CALM_LINE}.`}
      title="Risk is this reading. Calm counts clean LOW readings in a row. A HIGH or untrusted reading resets the count."
    >
      <div className={`metric-value tone-${tone}`}>
        {value}
        <span className="metric-unit">/ {CALM_NEEDED}</span>
      </div>
      <div className="calm-track" aria-hidden="true">
        <span
          className="calm-fill"
          style={{ width: `${String((value / CALM_NEEDED) * 100)}%` }}
        />
        <span className="calm-mark" />
      </div>
      <div className="metric-caption">{CALM_LINE}</div>
    </div>
  )
}
