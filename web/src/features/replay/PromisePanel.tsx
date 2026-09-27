import type { ReactNode } from "react"
import { promiseBreakdown, type ReplayPromiseResult } from "./promise"
import { mw } from "./format"

type Props = {
  tick: ReplayPromiseResult | null
  onOpenLedger: () => void
  onOpenData: () => void
}

function Row({ label, children, strong }: { label: string; children: ReactNode; strong?: boolean }) {
  return (
    <div className="replay-row">
      <span className={strong ? "is-confirmed" : undefined}>{label}</span>
      <b className={strong ? "is-confirmed" : undefined}>{children}</b>
    </div>
  )
}

export function PromisePanel({ tick, onOpenLedger, onOpenData }: Props) {
  const rows = tick ? promiseBreakdown(tick) : []
  const breaches = rows.find((row) => row.key === "breaches")
  const metricRows = rows.filter((row) => row.key !== "breaches")
  const breachCount = breaches && "count" in breaches ? breaches.count : null
  const why = tick?.brief ?? "Only confirmed energy is booked as sold. Missing values stay unreported."

  return (
    <section className="replay-panel replay-promise" aria-label="This tick">
      <p className="replay-label">This tick, whole fleet</p>
      {metricRows.length ? metricRows.map((row) => (
        <Row key={row.key} label={row.key === "asked" ? "Asked by ERCOT" : row.label} strong={row.key === "sold_confirmed"}>
          {"mw" in row ? mw(row.mw) : "Not reported"}
        </Row>
      )) : (
        <>
          <Row label="Asked by ERCOT">Not reported</Row>
          <Row label="Sold and confirmed" strong>Not reported</Row>
        </>
      )}
      <div className="replay-breaches">
        <span>Backup breaches</span>
        <b>{breachCount ?? "Not reported"}</b>
      </div>
      <p className="replay-note">{why}</p>
      <div className="replay-promise-actions">
        <button className="replay-pill replay-pill-full" type="button" onClick={onOpenLedger}>Open the ledger</button>
        <button className="replay-link-button" type="button" onClick={onOpenData}>About this data</button>
      </div>
    </section>
  )
}
