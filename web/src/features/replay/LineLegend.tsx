import type { Lens } from "./ScenarioRail"

/** Every kind of order line on Replay (ledger ruling, Task 16B), drawn exactly as each view draws it: the same token
 * colour, stroke width and dash as zone.css (zone board paths) and replay.css (map arcs). Always shown, never
 * conditional on what the tick drew, so a viewer can read a line before it appears. */
export type LineKind = {
  label: string
  stroke: string
  width: number
  dash?: string
  opacity?: number
  /** A marker, not a line: the map's lost-order dot. */
  dot?: boolean
}

/** Zone board order paths (zone.css `.zp.*`). A charge order keeps its state's dash in amber (`p-charge`). */
export const ZONE_LINES: readonly LineKind[] = [
  { label: "On its way", stroke: "var(--rg-order-way)", width: 4, dash: "10 8" },
  { label: "Retrying", stroke: "var(--rg-order-way)", width: 4, dash: "4 7" },
  { label: "Lost", stroke: "var(--rg-lost)", width: 4, dash: "2 7" },
  { label: "Lost on retry", stroke: "var(--rg-lost)", width: 4 },
  { label: "Gave energy", stroke: "var(--rg-gave-energy)", width: 5 },
  { label: "Confirmed", stroke: "var(--rg-confirmed)", width: 5 },
  { label: "Not counted", stroke: "var(--rg-not-counted)", width: 3, dash: "1 6" },
  { label: "Charging", stroke: "var(--rg-charging)", width: 5 },
]

const MAP_LOST: LineKind = { label: "Order lost on the way", stroke: "var(--rg-lost)", width: 0, dot: true }

/** Map arcs from the controller to each zone (replay.css `.arc-*`), by the lens the rail has picked. */
export const MAP_LINES: Readonly<Record<Lens, readonly LineKind[]>> = {
  send: [
    { label: "Orders out to sell", stroke: "var(--rg-gave-energy)", width: 3, dash: "10 9" },
    { label: "Charge orders", stroke: "var(--rg-charging)", width: 3, dash: "10 9" },
    MAP_LOST,
  ],
  keep: [
    { label: "Orders out (Keep view)", stroke: "var(--rg-charging)", width: 2, dash: "3 9", opacity: 0.7 },
    { label: "Charge orders", stroke: "var(--rg-charging)", width: 3, dash: "10 9" },
    MAP_LOST,
  ],
  trust: [
    { label: "Orders out (Trust view)", stroke: "var(--rg-gave-energy)", width: 2, opacity: 0.8 },
    { label: "Charge orders", stroke: "var(--rg-charging)", width: 3, dash: "10 9" },
    MAP_LOST,
  ],
}

function Swatch({ kind }: { kind: LineKind }) {
  return (
    <svg width="34" height="10" aria-hidden="true">
      {kind.dot ? (
        <circle cx="17" cy="5" r="4" style={{ fill: kind.stroke, stroke: "var(--rg-surface)" }} strokeWidth="1.5" />
      ) : (
        <line x1="1" y1="5" x2="33" y2="5" style={{ stroke: kind.stroke }} strokeWidth={kind.width}
          strokeDasharray={kind.dash} strokeLinecap="round" opacity={kind.opacity} />
      )}
    </svg>
  )
}

function Group({ title, kinds }: { title: string; kinds: readonly LineKind[] }) {
  return (
    <ul aria-label={`${title} lines`}>
      <li className="replay-line-legend-title">{title}</li>
      {kinds.map((kind) => (
        <li key={kind.label}>
          <Swatch kind={kind} />
          <span>{kind.label}</span>
        </li>
      ))}
    </ul>
  )
}

/** The map's lines are shown on the Texas map, the zone board's on a zone; `view` picks which group comes first. */
export function LineLegend({ lens = "send", view = "map" }: { lens?: Lens; view?: "map" | "zone" }) {
  const map = <Group key="map" title="Map" kinds={MAP_LINES[lens]} />
  const zone = <Group key="zone" title="Zone board" kinds={ZONE_LINES} />
  return <div className="replay-line-legend">{view === "zone" ? [zone, map] : [map, zone]}</div>
}
