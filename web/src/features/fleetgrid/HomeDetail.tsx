import { useEffect, useRef } from "react"
import { NO_ZONE, chargeText, floorText, nowText, replayHref, statusLabel, type GridHome } from "./fleetModel"

type HomeDetailProps = {
  home: GridHome
  onClose: () => void
}

/** Small detail panel for one battery. Replay has the full home panel; this links there. */
export function HomeDetail({ home, onClose }: HomeDetailProps) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [home.id])
  // On close (Close, Escape, or the parent clearing the selection), focus goes back to the home's tile.
  const openId = useRef(home.id)
  openId.current = home.id
  useEffect(() => () => {
    const tile = Array.from(document.querySelectorAll<HTMLElement>("[data-home]")).find((el) => el.dataset.home === openId.current)
    tile?.focus()
  }, [])
  return (
    <section
      ref={ref}
      className="fg-detail"
      aria-label="Home detail"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose()
      }}
    >
      <div className="fg-detail-head">
        <h2>{home.id}</h2>
        <button type="button" className="fg-pill" onClick={onClose}>Close</button>
      </div>
      <p className="fg-detail-zone">{home.zone === null ? NO_ZONE : `${home.zone} zone`}</p>
      <div className="fg-row first"><span>Status</span><b>{statusLabel(home)}</b></div>
      <div className="fg-row"><span>Charge</span><b>{chargeText(home)}</b></div>
      <div className="fg-row"><span>Backup floor</span><b>{floorText(home)}</b></div>
      <div className="fg-row"><span>Right now</span><b>{nowText(home)}</b></div>
      <p className="fg-detail-note">Replay shows this home&apos;s house and each order&apos;s journey.</p>
      <a href={replayHref(home)} className="fg-pill wide">Open in Replay</a>
    </section>
  )
}
