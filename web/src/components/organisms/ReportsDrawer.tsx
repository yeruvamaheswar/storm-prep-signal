import { feedStateLabel, feedStateTone, type FeedRow, type ReportFeeds } from "../../reportFeeds"

type ReportsDrawerProps = {
  feeds: ReportFeeds
}

/** React 19's details types omit defaultOpen. Set the DOM flag once so a bad pull starts open. */
export function openWhenBad(node: HTMLDetailsElement | null) {
  if (node !== null) {
    node.open = true
  }
}

/** Product, LZ, as-of, last success, state. Never EMIL columns. */
export function FeedsList({ rows }: { rows: FeedRow[] }) {
  return (
    <table className="feeds-list">
      <thead>
        <tr>
          <th>Product</th>
          <th>LZ</th>
          <th>As of</th>
          <th>Last success</th>
          <th>State</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={`${row.product}:${row.lz}`}>
            <td>{row.product}</td>
            <td>{row.lz}</td>
            <td>{row.asOf}</td>
            <td>{row.lastSuccess}</td>
            <td className={`tone-${feedStateTone(row.state)}`}>{feedStateLabel(row.state)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Feed status only. Opening it does not print an EMIL file. */
export function ReportsDrawer({ feeds }: ReportsDrawerProps) {
  return (
    <details
      key={feeds.badPull ? "bad-pull" : "clear"}
      className="reports-drawer"
      ref={feeds.badPull ? openWhenBad : undefined}
    >
      <summary>Feeds</summary>
      {feeds.purpose !== null ? <p className="reports-purpose">{feeds.purpose}</p> : null}
      <FeedsList rows={feeds.rows} />
    </details>
  )
}
