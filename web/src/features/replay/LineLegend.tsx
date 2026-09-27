/** Every kind of order line on Replay, the same on the Texas map and the zone board (ledger ruling, Task 16B). Always
 * shown, never conditional on what the tick drew, so a viewer can read a line before it appears. */
export const LINE_KINDS: ReadonlyArray<{ label: string; stroke: string; width: number; dash?: string }> = [
  { label: "On its way", stroke: "var(--rg-order-way)", width: 3, dash: "5 3" },
  { label: "Lost", stroke: "var(--rg-lost)", width: 3, dash: "2 4" },
  { label: "Gave energy", stroke: "var(--rg-gave-energy)", width: 4 },
  { label: "Confirmed", stroke: "var(--rg-confirmed)", width: 4 },
  { label: "Not counted", stroke: "var(--rg-not-counted)", width: 3, dash: "1 4" },
  { label: "Charging", stroke: "var(--rg-charging)", width: 4 },
]

export function LineLegend() {
  return (
    <div className="replay-line-legend">
      <ul aria-label="What the lines mean">
        {LINE_KINDS.map((kind) => (
          <li key={kind.label}>
            <svg width="22" height="6" aria-hidden="true">
              <line x1="1" y1="3" x2="21" y2="3" style={{ stroke: kind.stroke }} strokeWidth={kind.width} strokeDasharray={kind.dash} />
            </svg>
            <span>{kind.label}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
