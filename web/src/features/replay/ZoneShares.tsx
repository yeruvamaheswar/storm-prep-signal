import { FLOW_ZONES, type FlowZoneRow } from "../flow/types"
import { deliveryShare } from "../flow/flowMath"
import { NOT_REPORTED, mw } from "./format"

type Props = { zones: Partial<Record<string, FlowZoneRow>> }

/** Each zone's confirmed sale this tick, side by side, as a share of the fleet's confirmed sale. */
export function ZoneShares({ zones }: Props) {
  return (
    <ul className="replay-shares" aria-label="Zone shares this tick">
      {FLOW_ZONES.map((zone) => {
        const row = zones[zone]
        if (!row) {
          return (
            <li key={zone}>
              <b>{zone}</b>
              <span className="replay-shares-text">{NOT_REPORTED}</span>
            </li>
          )
        }
        const share = deliveryShare(zone, zones)
        return (
          <li key={zone}>
            <b>{zone}</b>
            <span className="replay-shares-track" aria-hidden="true">
              <span className="replay-shares-fill" style={{ transform: `scaleX(${share ?? 0})` }} />
            </span>
            <span className="replay-shares-text">
              {`${mw(row.selling_mw)} sold · ${share === null ? "No confirmed sale this tick" : `${Math.round(share * 100)}% of fleet`} · ${mw(row.charging_mw)} charging${row.grid_down ? " · grid down" : ""}`}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
