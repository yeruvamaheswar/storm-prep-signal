export const SESSION_SPEEDS = [15, 30, 60, 150, 300, 600] as const
export type SessionSpeed = (typeof SESSION_SPEEDS)[number]

export type ReplayClockInput = {
  playing: boolean
  nowMs: number
  tickArrivedAtMs: number
  stepSeconds: number
  scrubberT: number
}

export function stepSeconds(tickMinutes: number, speed: number): number {
  return (tickMinutes * 60) / speed
}

function clampT(t: number): number {
  return Math.min(125, Math.max(0, t))
}

export function replayTickSeconds(input: ReplayClockInput): number {
  if (!input.playing) return clampT(input.scrubberT)
  if (!(input.stepSeconds > 0)) return 0
  const elapsedSeconds = Math.max(0, (input.nowMs - input.tickArrivedAtMs) / 1000)
  return clampT((elapsedSeconds / input.stepSeconds) * 125)
}

export function fmtClock(tSeconds: number): string {
  const whole = Math.max(0, Math.floor(tSeconds))
  const minutes = Math.floor(whole / 60)
  const seconds = whole % 60
  return `${minutes}:${String(seconds).padStart(2, "0")}`
}
