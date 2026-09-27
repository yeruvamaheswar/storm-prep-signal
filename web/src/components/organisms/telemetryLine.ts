import type { TickView } from "../../contracts"

export type TelemetryLine = { live: string; suspect: number; readings: string }

const count = (n: number) => n.toLocaleString("en-US")
const isCount = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n)

/** The battery feed line under Worker acks. Null hides it: a missing count is never guessed. */
export function telemetryLine(tick: TickView): TelemetryLine | null {
  const homes = tick.telemetry?.plant?.homes
  const readings = tick.telemetry?.readings
  if (!homes || !readings) return null
  const { total, live, suspect } = homes
  const { received, accepted } = readings
  if (![total, live, suspect, received, accepted].every(isCount)) return null
  return {
    live: `${count(live)} of ${count(total)} live`,
    suspect,
    readings: `${count(accepted)} of ${count(received)} readings accepted`,
  }
}
