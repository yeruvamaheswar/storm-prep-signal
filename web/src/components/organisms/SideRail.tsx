import { reasonText, tapeStamp } from "../../format"
import { BriefBlock } from "../molecules/BriefBlock"
import { Key } from "../atoms/Key"
import { Label } from "../atoms/Label"

type SideRailProps = {
  brief: string
  reasons: string[]
  decisionLine: string | null
  tick: number
  tickCount: number
  quality?: string
  stamp?: string
}

export function SideRail({ brief, reasons, decisionLine, tick, tickCount, quality = "ok", stamp }: SideRailProps) {
  return (
    <aside className="side-rail" aria-label="Brief">
      <Key>Brief</Key>
      <BriefBlock text={brief} />
      <Key>Reasons</Key>
      {reasons.length === 0 ? (
        <Label>none</Label>
      ) : (
        <ul className="reason-list">
          {reasons.map((reason) => (
            <li key={reason}>{reasonText(reason)}</li>
          ))}
        </ul>
      )}
      <p className="rail-stamp">{stamp ?? tapeStamp(tick, tickCount, quality)}</p>
      {decisionLine ? (
        <p className="decision-line">{decisionLine}</p>
      ) : null}
    </aside>
  )
}
