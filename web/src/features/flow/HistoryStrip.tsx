import type { HistoryPoint } from "./types"

const W = 640
const H = 96
const PAD = 8

function line(points: HistoryPoint[], pick: (p: HistoryPoint) => number, peak: number, total: number): string {
  return points.map((p, i) => {
    const x = PAD + (i * (W - 2 * PAD)) / Math.max(1, total - 1)
    const y = H - PAD - (pick(p) / peak) * (H - 2 * PAD)
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`
  }).join(" ")
}

/** Grid ask (ink), confirmed delivery (OK), and charging (muted dashes) over the ticks played so far. */
export function HistoryStrip({ history, tickCount, targetLabel }: { history: HistoryPoint[]; tickCount: number; targetLabel: string }) {
  if (!history.length) return null
  const peak = Math.max(0.01, ...history.map((p) => Math.max(p.target_mw, p.delivered_mw, p.charging_mw)))
  const total = Math.max(tickCount, history.length)
  return (
    <figure className="flow-history">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Grid ask, delivery, and charging by tick">
        <path d={line(history, (p) => p.target_mw, peak, total)} className="flow-history-target" />
        <path d={line(history, (p) => p.delivered_mw, peak, total)} className="flow-history-delivered" />
        <path d={line(history, (p) => p.charging_mw, peak, total)} className="flow-history-charging" />
      </svg>
      <figcaption className="flow-muted">
        Ink: grid ask ({targetLabel}) · Green: confirmed delivery · Dashed: charging · peak {peak.toFixed(3)} MW
      </figcaption>
    </figure>
  )
}
