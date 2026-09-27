import type { HistoryPoint } from "../flow/types"
import { count, mw, plainReason, sum } from "./format"
import { promiseBreakdown } from "./promise"
import { useDrawerFocus } from "./useDrawer"

type Props = {
  title: string
  history: HistoryPoint[]
  onClose: () => void
}

export type LedgerRow = {
  tick: number
  asked?: number
  sold?: number
  notCounted?: number
  notSold?: number
  breaches?: number
  why: string
}

/** One ledger row per history point, using the promise panel's rule so nothing is counted twice:
 * missed_mw already includes unconfirmed_mw, so "not sold" is max(0, missed - unconfirmed), and only
 * when both are reported. A missing value stays undefined and renders as "Not reported". */
export function ledgerRow(point: HistoryPoint): LedgerRow {
  const rows = promiseBreakdown(point)
  const value = (key: string) => {
    const row = rows.find((item) => item.key === key)
    return row && "mw" in row ? row.mw : undefined
  }
  const notSoldRow = rows.find((item) => item.key === "not_sold")
  const notSold = value("not_sold")
  const reasonText = point.reasons?.length ? point.reasons.map(plainReason).join(", ") : ""
  const parts: string[] = []
  // Only name the not-sold reason when the amount shows as more than 0.000 MW in the table.
  if (notSoldRow && notSold !== undefined && notSold >= 0.0005) parts.push(notSoldRow.label)
  if (reasonText) parts.push(reasonText)
  return {
    tick: point.tick,
    asked: value("asked"),
    sold: value("sold_confirmed"),
    notCounted: value("sent_not_counted"),
    notSold,
    breaches: typeof point.breaches === "number" && Number.isFinite(point.breaches) ? point.breaches : undefined,
    why: parts.length ? parts.join(". ") : "None reported",
  }
}

export function LedgerDrawer({ title, history, onClose }: Props) {
  const ref = useDrawerFocus<HTMLElement>(onClose)
  const rows = history.map(ledgerRow)
  const asked = sum(rows.map((row) => row.asked))
  const sold = sum(rows.map((row) => row.sold))
  const notCounted = sum(rows.map((row) => row.notCounted))
  const notSold = sum(rows.map((row) => row.notSold))
  const breaches = sum(rows.map((row) => row.breaches))

  return (
    <section ref={ref} tabIndex={-1} role="dialog" className="replay-panel replay-drawer replay-ledger" aria-label="Ledger">
      <div className="replay-ledger-head">
        <div>
          <h2>{title}</h2>
          <p>Every tick's receipt. Only confirmed energy is booked as sold.</p>
        </div>
        <button className="replay-pill" type="button" onClick={onClose} aria-label="Close ledger">Close</button>
      </div>
      <table>
        <thead>
          <tr>
            <th>Tick</th>
            <th className="n">Asked</th>
            <th className="n">Sold</th>
            <th className="n">Not counted</th>
            <th className="n">Not sold</th>
            <th className="n">Breaches</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          {rows.length ? rows.map((row) => (
            <tr key={row.tick}>
              <td className="tick">{row.tick}</td>
              <td className="n">{mw(row.asked)}</td>
              <td className="n is-confirmed">{mw(row.sold)}</td>
              <td className="n">{mw(row.notCounted)}</td>
              <td className="n">{mw(row.notSold)}</td>
              <td className="n">{count(row.breaches)}</td>
              <td>{row.why}</td>
            </tr>
          )) : (
            <tr><td colSpan={7}>No ledger rows reported yet.</td></tr>
          )}
        </tbody>
      </table>
      <div className="replay-ledger-totals">
        <div><p className="replay-label">Asked over {rows.length} ticks</p><b>{mw(asked)}</b></div>
        <div><p className="replay-label">Sold and confirmed</p><b className="is-confirmed">{mw(sold)}</b></div>
        <div className="is-dark"><p className="replay-label">Backup breaches</p><b>{count(breaches)}</b></div>
      </div>
      <p className="replay-note">Not counted: {mw(notCounted)}. Not sold: {mw(notSold)}. Numbers come from the scenario worker's session state.</p>
    </section>
  )
}
