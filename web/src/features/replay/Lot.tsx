import type { Lens } from "./ScenarioRail"
import type { LotLook } from "./zoneModel"

type Props = {
  homeId: string
  look: LotLook
  /** Top-left of the 120 x 110 lot, in board-window pixels. */
  left: number
  top: number
  lens: Lens
  /** Keep lens: charge and floor as 0..1, null when not reported. */
  gauge: { charge: number | null; floor: number | null }
  /** Trust lens: stale, dead or unconfirmed mark, and a mismatch line. */
  trust: { mark: string | null; mismatch: string | null }
  open: boolean
  onOpen: (homeId: string) => void
}

const GAUGE_TOP = -46
const GAUGE_H = 30

function ariaText(look: LotLook, lens: Lens, gauge: Props["gauge"], trust: Props["trust"]): string {
  const parts = [look.aria]
  if (lens === "keep") {
    parts.push(gauge.charge === null ? "charge not reported" : `charge ${Math.round(gauge.charge * 100)}%`)
    parts.push(gauge.floor === null ? "floor not reported" : `floor ${Math.round(gauge.floor * 100)}%`)
  }
  if (lens === "trust") {
    if (trust.mark) parts.push(trust.mark.toLowerCase())
    if (trust.mismatch) parts.push(trust.mismatch)
  }
  return parts.join(", ")
}

/** One clay lot: lawn, slab, battery box with its state top, house, roof, window, pole and cable. */
export function Lot({ homeId, look, left, top, lens, gauge, trust, open, onOpen }: Props) {
  const low = gauge.charge !== null && gauge.floor !== null && gauge.charge <= gauge.floor
  return (
    <button
      type="button"
      className={`zone-lot${open ? " is-open" : ""}`}
      style={{ left, top }}
      data-home={homeId}
      aria-label={ariaText(look, lens, gauge, trust)}
      aria-expanded={open}
      onClick={() => onOpen(homeId)}
    >
      <svg width="120" height="110" viewBox="-60 -70 120 110" aria-hidden="true">
        <path d="M-48,0 L0,26 L0,32 L-48,6 Z" fill="#B3B7AF" />
        <path d="M0,26 L48,0 L48,6 L0,32 Z" fill="#A3A79F" />
        <path d="M0,-26 L48,0 L0,26 L-48,0 Z" style={{ fill: "var(--rg-clay-lawn)" }} />
        <path className="zone-lot-ring" d="M0,-26 L48,0 L0,26 L-48,0 Z" style={{ fill: look.glow, stroke: look.ring }} strokeWidth="3" />
        <path d="M-31,4 L-24,8 L-24,-3 L-31,-7 Z" fill="#DADCD6" />
        <path d="M-24,8 L-17,4 L-17,-7 L-24,-3 Z" fill="#C7CAC3" />
        <path d="M-31,-7 L-24,-11 L-17,-7 L-24,-3 Z" style={{ fill: look.batt }} />
        <path d="M-16,-2 L6,10 L6,-12 L-16,-24 Z" fill="#F4F3EF" />
        <path d="M6,10 L28,-2 L28,-24 L6,-12 Z" fill="#E1E0DA" />
        <path d="M-6,3 L-2,5 L-2,-6 L-6,-8 Z" fill="#2B302D" />
        <path d="M12.6,-1.3 L21.4,-6.1 L21.4,-13.8 L12.6,-9 Z" fill="#9AA8A3" />
        <path d="M-18,-23 L6,-11 L6,-42 Z" fill="#848A86" />
        <path d="M6,-11 L30,-23 L6,-42 Z" fill="#6F7571" />
        <line x1="36" y1="-8" x2="36" y2="-46" stroke="#5E645F" strokeWidth="2" />
        <line x1="31" y1="-43" x2="41" y2="-47" stroke="#5E645F" strokeWidth="2" />
        <path d="M36,-43 Q14,-36 -24,-9" fill="none" style={{ stroke: look.cable }} strokeWidth="2.5" strokeLinecap="round" />
        {lens === "keep" ? (
          <g className="zone-gauge">
            <rect x="-46" y={GAUGE_TOP} width="7" height={GAUGE_H} rx="1.5" fill="#FFFFFF" stroke="#5E645F" strokeWidth="1" />
            {gauge.charge !== null ? (
              <rect x="-45" y={GAUGE_TOP + GAUGE_H * (1 - gauge.charge)} width="5" height={GAUGE_H * gauge.charge}
                style={{ fill: low ? "var(--rg-charging)" : "var(--rg-gave-energy)" }} />
            ) : null}
            {gauge.floor !== null ? (
              <line x1="-49" x2="-36" y1={GAUGE_TOP + GAUGE_H * (1 - gauge.floor)} y2={GAUGE_TOP + GAUGE_H * (1 - gauge.floor)}
                style={{ stroke: "var(--rg-ink)" }} strokeWidth="1.6" />
            ) : null}
          </g>
        ) : null}
        {lens === "trust" && trust.mark ? (
          <path d="M0,-26 L48,0 L0,26 L-48,0 Z" fill="none" style={{ stroke: "var(--rg-not-counted)" }} strokeWidth="2" strokeDasharray="3 4" />
        ) : null}
      </svg>
      {lens === "trust" && (trust.mark || trust.mismatch) ? (
        <span className="zone-lot-mark" aria-hidden="true">{[trust.mark, trust.mismatch].filter(Boolean).join(". ")}</span>
      ) : null}
    </button>
  )
}
