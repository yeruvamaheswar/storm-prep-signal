import { inputRows, meaningLine, simulatedLine, type LiveStatus } from "./liveModel"

type Props = {
  status: LiveStatus
  snapshot: Record<string, unknown> | null
  fleetSize: number | null
  /** Only when something is wrong with the homes read (liveModel.homesWarning); a full live table says nothing. */
  homesWarning: string | null
}

function statusText(status: LiveStatus): string {
  if (status.kind === "loading") return "Reading the ERCOT snapshot."
  if (status.kind === "error") return "No snapshot, so no inputs are shown."
  return "Not live, so no inputs are shown as current."
}

/** "What ERCOT is telling us": only snapshot fields, and only while the page is live. */
export function LiveInputs({ status, snapshot, fleetSize, homesWarning }: Props) {
  if (status.kind !== "live" || !snapshot) {
    return (
      <section className="replay-panel live-inputs" aria-label="Live inputs">
        <p className="replay-label">What ERCOT is telling us</p>
        <p className={`live-status is-${status.kind}`} role="status">{statusText(status)}</p>
      </section>
    )
  }
  const rows = inputRows(snapshot)
  const meaning = meaningLine(snapshot)
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
      <p className="replay-note">{meaning ? `${meaning} ` : ""}{simulatedLine(snapshot, fleetSize)}</p>
      {homesWarning ? <p className="replay-note live-warning">{homesWarning}</p> : null}
    </section>
  )
}
