import { briefDecision, reasonText, tapeStamp } from "../../format"
import { feedReasons, type ReportFeeds } from "../../reportFeeds"
import { BriefBlock } from "../molecules/BriefBlock"
import { Key } from "../atoms/Key"
import { Label } from "../atoms/Label"
import { ReportsDrawer } from "./ReportsDrawer"

type SideRailProps = {
  brief: string
  reasons: string[]
  decisionLine: string | null
  tick: number
  tickCount: number
  feeds: ReportFeeds
  quality?: string
  stamp?: string
}

export function SideRail({ brief, reasons, decisionLine, tick, tickCount, feeds, quality = "ok", stamp }: SideRailProps) {
  const decision = briefDecision(decisionLine)
  const shown = feedReasons(reasons, feeds.holdingSpare)
  return (
    <aside className="side-rail" aria-label="Brief">
      <Key>Brief</Key>
      <BriefBlock text={brief} />
      <ReportsDrawer feeds={feeds} />
      <Key>Reasons</Key>
      {shown.length === 0 ? (
        <Label>none</Label>
      ) : (
        <ul className="reason-list">
          {shown.map((reason) => (
            <li key={reason}>{reasonText(reason)}</li>
          ))}
        </ul>
      )}
      <p className="rail-stamp">{stamp ?? tapeStamp(tick, tickCount, quality)}</p>
      {decision ? (
        <p className="decision-line">{decision}</p>
      ) : null}
    </aside>
  )
}
