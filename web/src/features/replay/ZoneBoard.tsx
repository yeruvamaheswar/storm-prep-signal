import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react"
import type { FlowHome, OrderTimelineEntry } from "../flow/types"
import { Lot } from "./Lot"
import { OrderPaths } from "./OrderPaths"
import type { Lens } from "./ScenarioRail"
import {
  SUBSTATION, WORLD, boardPath, keepGauge, lotLook, storyHomes, streetsPath, trustMarks, zoneLots, zonePaths,
} from "./zoneModel"
import "./zone.css"

type Props = {
  zone: string
  homes: FlowHome[]
  orders?: Record<string, OrderTimelineEntry[]>
  tSeconds: number
  lens: Lens
  tickMinutes?: number
  openHome: string | null
  onHome: (homeId: string) => void
  onBack: () => void
  backHref?: string
}

const BOARD = boardPath()
const STREETS = streetsPath()

function useFit(ref: React.RefObject<HTMLDivElement | null>) {
  const [fit, setFit] = useState({ scale: 1, dx: 0, dy: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      if (!(w > 0 && h > 0)) return
      const scale = Math.min(w / WORLD.w, h / WORLD.h, 1.4)
      setFit({ scale, dx: (w - WORLD.w * scale) / 2, dy: (h - WORLD.h * scale) / 2 })
    }
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return fit
}

const LEGEND: Array<{ label: string; stroke: string; width: number; dash?: string }> = [
  { label: "On its way", stroke: "var(--rg-order-way)", width: 3, dash: "5 3" },
  { label: "Lost", stroke: "var(--rg-lost)", width: 3, dash: "2 4" },
  { label: "Gave energy", stroke: "var(--rg-gave-energy)", width: 4 },
  { label: "Confirmed", stroke: "var(--rg-confirmed)", width: 4 },
  { label: "Not counted", stroke: "var(--rg-not-counted)", width: 3, dash: "1 4" },
]

/** The clay isometric neighbourhood of one zone's homes, ported from the approved Zone mockup. */
export function ZoneBoard({ zone, homes, orders, tSeconds, lens, tickMinutes, openHome, onHome, onBack, backHref = "/" }: Props) {
  const fitRef = useRef<HTMLDivElement | null>(null)
  const fit = useFit(fitRef)
  const lots = useMemo(() => zoneLots(homes, zone), [homes, zone])
  const paths = useMemo(() => zonePaths(lots.slots, orders, tSeconds), [lots, orders, tSeconds])
  const shownIds = useMemo(() => lots.slots.flatMap((lot) => (lot.home ? [lot.home.id] : [])), [lots])
  const story = useMemo(() => storyHomes(orders ?? {}, shownIds), [orders, shownIds])
  const hasCharge = paths.some((path) => path.charging)

  // Return focus to the lot whose panel just closed.
  const previousHome = useRef<string | null>(openHome)
  useEffect(() => {
    const was = previousHome.current
    previousHome.current = openHome
    if (was && !openHome) {
      const lots = fitRef.current?.querySelectorAll<HTMLButtonElement>("button[data-home]") ?? []
      for (const lot of lots) if (lot.dataset.home === was) lot.focus()
    }
  }, [openHome])

  const subLabel = [SUBSTATION[0] - 64 - WORLD.x, SUBSTATION[1] + 27 - WORLD.y]

  function back(event: MouseEvent<HTMLAnchorElement>) {
    // Let ctrl/cmd/shift/middle clicks open the link the browser's way.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    onBack()
  }

  return (
    <div className={`zone-stage${openHome ? " has-home" : ""}`}>
      <svg className="zone-grain" aria-hidden="true">
        <defs>
          <filter id="zone-clay-grain" x="0" y="0" width="100%" height="100%">
            <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" seed="5" />
            <feColorMatrix values="0 0 0 0 0.3  0 0 0 0 0.34  0 0 0 0 0.3  0 0 0 0.05 0" />
          </filter>
        </defs>
        <rect width="100%" height="100%" filter="url(#zone-clay-grain)" />
      </svg>

      <div className="zone-fit" ref={fitRef}>
        <div className="zone-world" style={{ width: WORLD.w, height: WORLD.h, transform: `translate(${fit.dx}px, ${fit.dy}px) scale(${fit.scale})` }}
>
          <svg className="zone-layer" width={WORLD.w} height={WORLD.h} viewBox={`${WORLD.x} ${WORLD.y} ${WORLD.w} ${WORLD.h}`} aria-hidden="true">
            <path d={BOARD} style={{ fill: "var(--rg-clay-board)" }} />
            <path d={STREETS} fill="none" style={{ stroke: "var(--rg-clay-street)" }} strokeWidth="16" strokeLinecap="round" />
            <path d={STREETS} fill="none" stroke="#E6E8E3" strokeWidth="1.5" strokeDasharray="6 8" />
            <g transform={`translate(${SUBSTATION[0]},${SUBSTATION[1]})`}>
              <path d="M-26,0 L0,14 L0,-8 L-26,-22 Z" fill="#9EA39C" />
              <path d="M0,14 L26,0 L26,-22 L0,-8 Z" fill="#8B908A" />
              <path d="M-26,-22 L0,-36 L26,-22 L0,-8 Z" fill="#B7BBB4" />
              <path d="M2,-30 L-4,-21 H3 L-2,-13" fill="none" stroke="#0E6F78" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </g>
          </svg>
          <div className="zone-sub-label" style={{ left: subLabel[0], top: subLabel[1] }}>{zone} substation</div>

          <OrderPaths paths={paths} />

          {lots.slots.map((lot) => {
            const left = lot.cx - 60 - WORLD.x
            const top = lot.cy - 70 - WORLD.y
            if (!lot.home) {
              return (
                <div key={`empty-${lot.slot}`} className="zone-lot is-empty" style={{ left, top }} aria-hidden="true">
                  <svg width="120" height="110" viewBox="-60 -70 120 110">
                    <path d="M-48,0 L0,26 L0,32 L-48,6 Z" fill="#B3B7AF" />
                    <path d="M0,26 L48,0 L48,6 L0,32 Z" fill="#A3A79F" />
                    <path d="M0,-26 L48,0 L0,26 L-48,0 Z" style={{ fill: "var(--rg-clay-lawn)" }} opacity="0.5" />
                  </svg>
                </div>
              )
            }
            const home = lot.home
            const timeline = orders?.[home.id]
            return (
              <Lot
                key={home.id}
                homeId={home.id}
                look={lotLook(home, timeline, tSeconds, openHome === home.id)}
                left={left}
                top={top}
                lens={lens}
                gauge={keepGauge(home)}
                trust={trustMarks(home, timeline, tSeconds, tickMinutes)}
                open={openHome === home.id}
                onOpen={onHome}
              />
            )
          })}

          {story.map((id) => {
            const lot = lots.slots.find((slot) => slot.home?.id === id)
            if (!lot?.home) return null
            const look = lotLook(lot.home, orders?.[id], tSeconds, false)
            return (
              <div key={`tag-${id}`} className="zone-tag" style={{ left: lot.cx - 20 - WORLD.x, top: lot.cy - 104 - WORLD.y, borderColor: look.ring === "rgba(0,0,0,0)" ? "var(--rg-ink)" : look.ring }}>
                {id}: {look.label}
              </div>
            )
          })}
        </div>
      </div>

      <div className="replay-panel zone-crumb">
        <nav aria-label="Where you are">
          <a href={backHref} onClick={back}>Texas</a>
          <span className="sep" aria-hidden="true">/</span>
          <b aria-current="page">{zone}</b>
          {lots.total > lots.shown ? <span className="zone-more">Showing {lots.shown} of {lots.total}</span> : null}
        </nav>
        <div className="zone-legend">
          {LEGEND.map((item) => (
            <span key={item.label} className="lg">
              <svg width="22" height="6" aria-hidden="true">
                <line x1="1" y1="3" x2="21" y2="3" style={{ stroke: item.stroke }} strokeWidth={item.width} strokeDasharray={item.dash} />
              </svg>
              {item.label}
            </span>
          ))}
          {hasCharge ? (
            <span className="lg">
              <svg width="22" height="6" aria-hidden="true"><line x1="1" y1="3" x2="21" y2="3" style={{ stroke: "var(--rg-charging)" }} strokeWidth="4" /></svg>
              Charging
            </span>
          ) : null}
        </div>
      </div>
    </div>
  )
}
