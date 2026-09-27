import { cellGeometry, cellLook, pctLabel, shortId, tileAria, type GridHome } from "./fleetModel"

type BatteryCellProps = {
  home: GridHome
  dim: boolean
  selected: boolean
  found: boolean
  onSelect: (id: string) => void
}

/** One vertical "Base" battery cell, 36 × 60, as in mockup/Fleet.dc.html. */
export function BatteryCell({ home, dim, selected, found, onSelect }: BatteryCellProps) {
  const g = cellGeometry(home)
  const look = cellLook(home)
  const pct = pctLabel(home)
  const na = home.socPct === null && home.status !== "offline"
  const cls = [
    "fg-tile",
    home.status === "offline" ? "off" : "",
    home.status === "stale" ? "stale" : "",
    dim ? "dim" : "",
    selected ? "sel" : "",
    found ? "hit" : "",
  ].filter(Boolean).join(" ")
  return (
    <button type="button" className={cls} aria-label={tileAria(home)} data-home={home.id} onClick={() => onSelect(home.id)}>
      <svg width="36" height="60" viewBox="0 0 36 60" aria-hidden="true">
        <rect x="1.5" y="1.5" width="33" height="57" rx="8" fill={look.shell} stroke={look.edge} strokeWidth="2.2" strokeDasharray={look.dash} />
        <rect x="5" y="5" width="26" height="50" rx="4.5" fill={look.well} />
        {g.fillY === null || g.fillH === null ? null : (
          <rect className="fg-fill" x="5" y={g.fillY.toFixed(1)} width="26" height={g.fillH.toFixed(1)} rx="4.5" fill={look.fill} />
        )}
        {g.floorY === null ? null : (
          <line x1="5" y1={g.floorY.toFixed(1)} x2="31" y2={g.floorY.toFixed(1)} stroke="var(--rg-ink)" strokeWidth="1.3" strokeDasharray="2.5 2" />
        )}
        <text
          x="18" y="30" transform="rotate(-90 18 30)" textAnchor="middle" dominantBaseline="central"
          fontFamily="Overpass, sans-serif" fontSize="11" fontWeight="800" letterSpacing="1"
          fill={look.word} stroke={look.wordEdge} strokeWidth="2.4" paintOrder="stroke"
        >
          BASE
        </text>
      </svg>
      <span className={na ? "fg-label na" : "fg-label"}>
        <span className="id">{shortId(home.id)}</span>
        <span className={na ? "pc na" : "pc"}>{pct}</span>
      </span>
    </button>
  )
}
