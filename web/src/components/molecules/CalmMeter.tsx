import { CALM_NEEDED } from "../../calmStreak"

type CalmMeterProps = {
  streak: number
}

export function CalmMeter({ streak }: CalmMeterProps) {
  const pips = Array.from({ length: CALM_NEEDED }, (_, index) => index < streak)
  return (
    <div
      className="calm-meter"
      role="meter"
      aria-label="Calm readings"
      aria-valuemin={0}
      aria-valuemax={CALM_NEEDED}
      aria-valuenow={streak}
    >
      <div className="calm-pips">
        {pips.map((filled, index) => (
          <span key={index} className={filled ? "calm-pip is-filled" : "calm-pip"} />
        ))}
      </div>
      <div className="metric-caption">
        calm {streak}/{CALM_NEEDED}
      </div>
    </div>
  )
}
