import { useEffect, useState } from "react"
import type { TickView } from "../../contracts"
import { isLoadZone, type LoadZone } from "../../zonePaint"
import { Button } from "../atoms/Button"
import { Key } from "../atoms/Key"
import {
  DEAD_AFTER_MS,
  ackMark,
  ackMarkCounts,
  ackSummary,
  ackTicks,
  ackZones,
  tickFailSafe,
  zoneAcked,
} from "./ackTicks"

type AckRailProps = {
  tick: TickView
  zone?: LoadZone | null
  onSelectZone?: (zone: LoadZone) => void
  onClearZone?: () => void
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

/** One tick per home. Color follows the home: discharging ack, held, silent, or dead / fail-safe. */
export function AckRail({ tick, zone = null, onSelectZone, onClearZone }: AckRailProps) {
  const elapsed = useAckClock(tick)
  const ticks = ackTicks(tick)
  const failSafe = tickFailSafe(tick)
  const marks = ackMarkCounts(ticks, elapsed, failSafe)

  return (
    <section className="ack-rail" aria-label="Worker acks">
      <div className="ack-rail-head">
        <Key>Worker acks</Key>
        <Button pressed={zone === null} label="Show every load zone" onClick={() => onClearZone?.()}>
          All zones
        </Button>
        <p className="ack-caption" role="status">
          {ackSummary(marks, tick.delivered_mw)}
        </p>
      </div>
      <div className="ack-zones">
        {ackZones(ticks).map(({ zone: name, ticks: zoneTicks }) => {
          const acked = zoneAcked(zoneTicks, elapsed, failSafe)
          const selected = zone === name
          return (
            <button
              key={name}
              type="button"
              className={selected ? "ack-zone is-selected" : "ack-zone"}
              aria-pressed={selected}
              onClick={() => {
                if (isLoadZone(name)) onSelectZone?.(name)
              }}
            >
              <span className="label">
                {name} {acked}/{zoneTicks.length}
              </span>
              <div className="ack-ticks">
                {zoneTicks.map((item) => {
                  const mark = ackMark(item, elapsed, failSafe)
                  return (
                    <span
                      key={item.index}
                      className={`ack-tick ack-${mark}`}
                      data-state={mark}
                      title={`${name} · ${mark} · ${item.home}`}
                    />
                  )
                })}
              </div>
            </button>
          )
        })}
      </div>
    </section>
  )
}
