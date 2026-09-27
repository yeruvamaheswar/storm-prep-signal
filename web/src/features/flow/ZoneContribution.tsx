import {
  CONTRIBUTION_COLOR,
  CONTRIBUTION_LABEL,
  CONTRIBUTION_ORDER,
  contributionParts,
  deliveryShare,
  fmtMw,
} from "./flowMath"
import type { FlowZoneRow } from "./types"

type Props = { zones: Partial<Record<string, FlowZoneRow>> }

/** One bar per zone: its homes by what they give the grid this tick, with the zone's MW beside it. */
export function ZoneContribution({ zones }: Props) {
  const names = Object.keys(zones).sort()
  if (!names.length) return null
  return (
    <section className="flow-contrib" aria-label="Zone contribution">
      {names.map((zone) => {
        const row = zones[zone]
        const parts = contributionParts(row)
        const homes = row?.homes || 1
        const share = deliveryShare(zone, zones)
        return (
          <div key={zone} className="flow-contrib-row">
            <span className="flow-contrib-name">{zone}</span>
            <div className="flow-contrib-bar" role="img"
              aria-label={CONTRIBUTION_ORDER.map((part) => `${parts[part]} ${CONTRIBUTION_LABEL[part].toLowerCase()}`).join(", ")}>
              {CONTRIBUTION_ORDER.filter((part) => parts[part] > 0).map((part) => (
                <span key={part} className="flow-contrib-seg"
                  style={{ width: `${(100 * parts[part]) / homes}%`, background: CONTRIBUTION_COLOR[part] }}
                  title={`${parts[part]} of ${row?.homes ?? 0} homes · ${CONTRIBUTION_LABEL[part]}`} />
              ))}
            </div>
            <span className="flow-contrib-mw">
              sell {fmtMw(row?.selling_mw)} confirmed
              {share === null ? "" : ` · ${Math.round(100 * share)}% of fleet`}
              {row && row.charging_mw > 0 ? ` · charge ${fmtMw(row.charging_mw)}` : ""}
            </span>
          </div>
        )
      })}
      <ul className="flow-legend">
        {CONTRIBUTION_ORDER.map((part) => (
          <li key={part}><span className="flow-swatch" style={{ background: CONTRIBUTION_COLOR[part] }} />{CONTRIBUTION_LABEL[part]}</li>
        ))}
        <li>Bar width: share of the zone's homes</li>
      </ul>
    </section>
  )
}
