import type { HistoryPoint } from "../flow/types"
import { mw, plainReason, sum } from "./format"

type Props = {
  title: string
  history: HistoryPoint[]
  onClose: () => void
}

function reasons(row: HistoryPoint): string {
  return row.reasons?.length ? row.reasons.map(plainReason).join(", ") : "None reported"
}

export function LedgerDrawer({ title, history, onClose }: Props) {
  const asked = sum(history.map((row) => row.target_mw))
  const sold = sum(history.map((row) => row.delivered_mw))
  const notCounted = sum(history.map((row) => row.unconfirmed_mw))
  const notSent = sum(history.map((row) => row.missed_mw))

  return (
    <section className="replay-panel replay-ledger" aria-label="Ledger">
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
            <th className="n">Not sent</th>
            <th className="n">Breaches</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          {history.length ? history.map((row) => (
            <tr key={row.tick}>
              <td className="tick">{row.tick}</td>
              <td className="n">{mw(row.target_mw)}</td>
              <td className="n is-confirmed">{mw(row.delivered_mw)}</td>
              <td className="n">{mw(row.unconfirmed_mw)}</td>
              <td className="n">{mw(row.missed_mw)}</td>
              <td className="n">0</td>
              <td>{reasons(row)}</td>
            </tr>
          )) : (
            <tr><td colSpan={7}>No ledger rows reported yet.</td></tr>
          )}
        </tbody>
      </table>
      <div className="replay-ledger-totals">
        <div><p className="replay-label">Asked over {history.length || 0} ticks</p><b>{mw(asked)}</b></div>
        <div><p className="replay-label">Sold and confirmed</p><b className="is-confirmed">{mw(sold)}</b></div>
        <div className="is-dark"><p className="replay-label">Backup breaches</p><b>0</b></div>
      </div>
      <p className="replay-note">Not counted: {mw(notCounted)}. Not sent: {mw(notSent)}. Numbers come from the scenario worker's session state.</p>
    </section>
  )
}
