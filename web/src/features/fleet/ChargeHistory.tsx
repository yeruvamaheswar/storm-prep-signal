import type { HomeHistoryCommand, HomeReading } from "../../domain/types"
import { ackClass, ackText, formatSeen, quantity } from "./display"

export type ChargeHistoryProps = {
  readings: HomeReading[]
  commands: HomeHistoryCommand[]
  floorKwh: number
}

const WIDTH = 320
const HEIGHT = 120
const PAD_LEFT = 36
const PAD_RIGHT = 8
const PAD_TOP = 8
const PAD_BOTTOM = 20
const FONT = "IBM Plex Sans, sans-serif"

function yFor(value: number, min: number, max: number): number {
  const plotH = HEIGHT - PAD_TOP - PAD_BOTTOM
  if (max === min) return PAD_TOP + plotH / 2
  return PAD_TOP + (1 - (value - min) / (max - min)) * plotH
}

function xFor(index: number, count: number): number {
  const plotW = WIDTH - PAD_LEFT - PAD_RIGHT
  if (count === 1) return PAD_LEFT + plotW / 2
  return PAD_LEFT + (index / (count - 1)) * plotW
}

/**
 * Charge over time for one home, plus the controller orders behind it.
 * Readings and commands stay oldest-first so the graph left-to-right
 * matches the list top-to-bottom (newest at the bottom of both).
 */
export function ChargeHistory({ readings, commands, floorKwh }: ChargeHistoryProps) {
  const hasSeries = readings.length > 0
  const values = readings.map((reading) => reading.soc_kwh).concat([floorKwh])
  const min = hasSeries ? Math.min(...values) : 0
  const max = hasSeries ? Math.max(...values) : 0
  const points = readings
    .map((reading, index) => `${xFor(index, readings.length).toFixed(1)},${yFor(reading.soc_kwh, min, max).toFixed(1)}`)
    .join(" ")
  const floorY = yFor(floorKwh, min, max)
  const firstSeen = hasSeries ? formatSeen(readings[0].seen_at) : "—"
  const lastSeen = hasSeries ? formatSeen(readings[readings.length - 1].seen_at) : "—"
  const singleTimeLabel = firstSeen === lastSeen

  return (
    <>
      <section className="fleet-command" aria-label="Charge history">
        <h2>Charge history</h2>
        {hasSeries ? (
          <>
            <svg
              viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
              width="100%"
              role="img"
              aria-label={`Charge from ${firstSeen} to ${lastSeen}`}
              style={{ background: "var(--field)", display: "block" }}
            >
              <line
                x1={PAD_LEFT}
                x2={WIDTH - PAD_RIGHT}
                y1={floorY}
                y2={floorY}
                stroke="var(--line)"
                strokeWidth={1}
              />
              {readings.length === 1 ? (
                <circle
                  cx={xFor(0, 1)}
                  cy={yFor(readings[0].soc_kwh, min, max)}
                  r={2.5}
                  fill="var(--ink)"
                />
              ) : (
                <polyline
                  points={points}
                  fill="none"
                  stroke="var(--ink)"
                  strokeWidth={1.5}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              )}
              <text
                x={PAD_LEFT - 4}
                y={PAD_TOP + 8}
                textAnchor="end"
                fontSize={10}
                fill="var(--muted)"
                fontFamily={FONT}
              >
                {quantity(max)}
              </text>
              <text
                x={PAD_LEFT - 4}
                y={PAD_TOP + (HEIGHT - PAD_TOP - PAD_BOTTOM)}
                textAnchor="end"
                fontSize={10}
                fill="var(--muted)"
                fontFamily={FONT}
              >
                {quantity(min)}
              </text>
              <text
                x={WIDTH - PAD_RIGHT}
                y={floorY - 3}
                textAnchor="end"
                fontSize={10}
                fill="var(--muted)"
                fontFamily={FONT}
              >
                floor
              </text>
              {singleTimeLabel ? (
                <text
                  x={PAD_LEFT + (WIDTH - PAD_LEFT - PAD_RIGHT) / 2}
                  y={HEIGHT - 6}
                  textAnchor="middle"
                  fontSize={10}
                  fill="var(--muted)"
                  fontFamily={FONT}
                >
                  {firstSeen}
                </text>
              ) : (
                <>
                  <text
                    x={PAD_LEFT}
                    y={HEIGHT - 6}
                    textAnchor="start"
                    fontSize={10}
                    fill="var(--muted)"
                    fontFamily={FONT}
                  >
                    {firstSeen}
                  </text>
                  <text
                    x={WIDTH - PAD_RIGHT}
                    y={HEIGHT - 6}
                    textAnchor="end"
                    fontSize={10}
                    fill="var(--muted)"
                    fontFamily={FONT}
                  >
                    {lastSeen}
                  </text>
                </>
              )}
            </svg>
          </>
        ) : (
          <p className="fleet-metric-value fleet-tone-muted">—</p>
        )}
      </section>
      <section className="fleet-command" aria-label="Commands">
        <h2>Commands</h2>
        {commands.length === 0 ? (
          <p className="fleet-metric-value fleet-tone-muted">—</p>
        ) : (
          <ul aria-label="Commands" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {commands.map((command) => (
              <li
                key={command.command_id}
                style={{ display: "flex", gap: "12px", alignItems: "baseline", padding: "8px 0", borderBottom: "1px solid var(--line)" }}
              >
                <span style={{ fontVariantNumeric: "tabular-nums" }}>
                  {quantity(command.kw)}
                  <span className="fleet-unit">kW</span>
                </span>
                <span className={ackClass(command.ack)}>{ackText(command.ack)}</span>
                <span className="fleet-sent">{formatSeen(command.sent_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}
