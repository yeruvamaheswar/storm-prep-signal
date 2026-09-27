import type { ReactNode } from "react"
import { intentLine } from "./intentCopy"
import { promiseBreakdown, type ReplayPromiseResult } from "./promise"
import { mw } from "./format"

type Props = {
  tick: ReplayPromiseResult | null
  onOpenLedger: (opener: HTMLElement | null) => void
  onOpenData: (opener: HTMLElement | null) => void
}

function Row({ label, children, tone, className }: { label: string; children: ReactNode; tone?: string; className?: string }) {
  return (
    <div className={className ? `replay-row ${className}` : "replay-row"}>
      <span className={tone}>{label}</span>
      <b className={tone}>{children}</b>
    </div>
  )
}

export function PromisePanel({ tick, onOpenLedger, onOpenData }: Props) {
  const rows = tick ? promiseBreakdown(tick) : []
  const breaches = rows.find((row) => row.key === "breaches")
  const charged = rows.find((row) => row.key === "charged")
  const metricRows = rows.filter((row) => row.key !== "breaches" && row.key !== "charged")
  const breachCount = breaches && "count" in breaches ? breaches.count : null
  const why = tick?.brief ?? "Only confirmed energy is booked as sold. Missing values stay unreported."
  const did = tick ? intentLine(tick.intent, tick.intent_reason) : null

  return (
    <section className="replay-panel replay-promise" aria-label="This tick">
      <p className="replay-label">This tick, whole fleet</p>
      {did ? <p className="replay-intent">{did}</p> : null}
      {metricRows.length ? metricRows.map((row) => (
        <Row key={row.key} label={row.key === "asked" ? "Asked by ERCOT" : row.label} tone={row.key === "sold_confirmed" ? "is-confirmed" : undefined}>
          {"mw" in row ? mw(row.mw) : "Not reported"}
        </Row>
      )) : (
        <>
          <Row label="Asked by ERCOT">Not reported</Row>
          <Row label="Sold and confirmed" tone="is-confirmed">Not reported</Row>
        </>
      )}
      {charged && "mw" in charged ? (
        // Bought, not sold: set apart from the call's rows and never added to them.
        <Row label={charged.label} tone="is-charge" className="replay-row-charge">{mw(charged.mw)}</Row>
      ) : null}
      <div className="replay-breaches">
        <span>Backup breaches</span>
        <b className={breachCount === null ? "is-missing" : undefined}>{breachCount ?? "Not reported"}</b>
      </div>
      <p className="replay-note">{why}</p>
      <div className="replay-promise-actions">
        <button className="replay-pill replay-pill-full" type="button" onClick={(event) => onOpenLedger(event.currentTarget)}>Open the ledger</button>
        <button className="replay-pill replay-pill-full replay-pill-secondary" type="button" onClick={(event) => onOpenData(event.currentTarget)}>About this data</button>
      </div>
    </section>
  )
}
