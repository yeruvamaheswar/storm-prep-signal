import type { FlowHome, FlowTick, OrderTimelineEntry } from "../flow/types"
import { feedLines } from "./narrate"

type Props = {
  orders?: Record<string, OrderTimelineEntry[]>
  homes: FlowHome[]
  tick: FlowTick | null
  tSeconds: number
}

export function FeedPanel({ orders = {}, homes, tick, tSeconds }: Props) {
  const homesById = Object.fromEntries(homes.map((home) => [home.id, home]))
  const lines = feedLines(orders, tSeconds, homesById, { breaches: tick?.breaches })
  return (
    <section className="replay-panel replay-feed" aria-label="What happened">
      <p className="replay-label">What happened</p>
      {lines.length ? lines.slice(0, 8).map((line, index) => (
        <div key={`${line.t}-${index}-${line.x}`} className="replay-feed-line">
          <span className="mark" style={{ background: line.c }} />
          <span className="time">{line.t}</span>
          <span>{line.x}</span>
        </div>
      )) : <p className="replay-empty-small">No order events reported yet.</p>}
    </section>
  )
}
