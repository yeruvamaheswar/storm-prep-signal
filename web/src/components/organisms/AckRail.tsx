import { useEffect, useState } from "react"
import type { TickView } from "../../contracts"
import { ackCaption } from "../../format"
import { Key } from "../atoms/Key"
import { DEAD_AFTER_MS, ackCounts, ackState, ackTicks, ackZones } from "./ackTicks"

type AckRailProps = {
  tick: TickView
}

const STEP_MS = 100

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
}

/** Clock for one command round. Stops once every silent worker has been written off. */
function useAckClock(tick: TickView): number {
  const [elapsed, setElapsed] = useState(() => (reducedMotion() ? DEAD_AFTER_MS : 0))

  useEffect(() => {
    if (reducedMotion()) {
      setElapsed(DEAD_AFTER_MS)
      return
    }
    const start = performance.now()
    setElapsed(0)
    const timer = window.setInterval(() => {
      const now = performance.now() - start
      setElapsed(Math.min(now, DEAD_AFTER_MS))
      if (now >= DEAD_AFTER_MS) {
        window.clearInterval(timer)
      }
    }, STEP_MS)
    return () => window.clearInterval(timer)
  }, [tick])

  return elapsed
}

/** One tick per home, grouped by zone: pending, then acked or unconfirmed at 2s, then dead. */
export function AckRail({ tick }: AckRailProps) {
  const elapsed = useAckClock(tick)
  const ticks = ackTicks(tick)
  const counts = ackCounts(ticks, elapsed)

  return (
    <section className="ack-rail" aria-label="Worker acks">
      <div className="ack-rail-head">
        <Key>Worker acks</Key>
        <p className="ack-caption" role="status">
          {ackCaption(counts, tick.delivered_mw)}
        </p>
      </div>
      <div className="ack-zones">
        {ackZones(ticks).map(({ zone, ticks: zoneTicks }) => {
          const acked = zoneTicks.filter((item) => ackState(item, elapsed) === "acked").length
          return (
            <div key={zone} className="ack-zone">
              <span className="label">
                {zone} {acked}/{zoneTicks.length}
              </span>
              <div className="ack-ticks">
                {zoneTicks.map((item) => {
                  const state = ackState(item, elapsed)
                  return (
                    <span
                      key={item.index}
                      className={`ack-tick ack-${state}`}
                      data-state={state}
                      title={`${zone} · ${state} · ${item.home}`}
                    />
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
