import { ZONE_NOTE, inputRows, provenanceLines, type LiveStatus } from "./liveModel"

type Props = {
  status: LiveStatus
  snapshot: Record<string, unknown> | null
  fleetSize: number | null
  /** The homes reply's own source note, or why the homes could not be read. */
  homesNote: string | null
}

function statusText(status: LiveStatus): string {
  if (status.kind === "loading") return "Reading the ERCOT snapshot."
  if (status.kind === "error") return "No snapshot, so no inputs are shown."
  return "Not live, so no inputs are shown as current."
}

/** "What ERCOT is telling us": only snapshot fields, and only while the page is live. */
export function LiveInputs({ status, snapshot, fleetSize, homesNote }: Props) {
  if (status.kind !== "live" || !snapshot) {
    return (
      <section className="replay-panel live-inputs" aria-label="Live inputs">
        <p className="replay-label">What ERCOT is telling us</p>
        <p className={`live-status is-${status.kind}`} role="status">{statusText(status)}</p>
      </section>
    )
  }
  const rows = inputRows(snapshot)
  return (
    <section className="replay-panel live-inputs" aria-label="Live inputs">
      <p className="replay-label">What ERCOT is telling us</p>
      {rows.map((row) => (
        <div key={row.key} className="live-row">
          <span>{row.label}</span>
          <b className={row.tone ? `is-${row.tone}` : undefined}>
            {row.value}
            {row.unit ? <span className="live-unit"> {row.unit}</span> : null}
          </b>
        </div>
      ))}
      {provenanceLines(snapshot, fleetSize).map((line) => <p key={line} className="replay-note">{line}</p>)}
      <p className="replay-note">{ZONE_NOTE}</p>
      {homesNote ? <p className="replay-note">{homesNote}</p> : null}
    </section>
  )
}
