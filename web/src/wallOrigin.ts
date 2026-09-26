import type { RuntimeMode } from "./runtimeMode"

/** Where the wall numbers came from. Demo is the layout tape. Live and archive poll /v1/snapshot. */
export type WallSourceKind = "live" | "archive" | "fixture"

/** Wall clock, a pinned archive posting, or the 12-tick fixture clock. */
export type WallClock = "wall" | "archive" | "fixture"

export type SourceChip = "LIVE" | "ARCHIVE" | "DEMO"

export type WallOrigin = {
  kind: WallSourceKind
  event: string | null
  eventLabel: string | null
  clock: WallClock
  clockAt: string | null
  chip: SourceChip
  place: string
  showScrubber: boolean
}

export type OriginInput = {
  runtime: RuntimeMode
  source?: string | null
  event?: string | null
  clock?: string | null
  runId?: string | null
  intervalLabel?: string | null
}

function eventName(event: string | null | undefined): string | null {
  const name = event?.trim() ?? ""
  return name === "" ? null : name
}

function titleEvent(event: string): string {
  return event.charAt(0).toUpperCase() + event.slice(1)
}

function isLayoutFixture(runId: string | null | undefined): boolean {
  return (runId ?? "").trim() === "layout-fixture"
}

function isIsoClock(clock: string | null | undefined): boolean {
  return typeof clock === "string" && clock.includes("T") && clock.length >= 19
}

function isArchive(source: string | null | undefined, event: string | null, clock: string | null | undefined): boolean {
  if (source === "archive" || clock === "archive") return true
  if (event !== null && source !== "live" && source !== "fixture") return true
  return false
}

/**
 * Mast source, event, and clock. LIVE and ARCHIVE hide the 01–12 scrubber.
 * Only layout-fixture keeps the tape buttons.
 */
export function wallOrigin(input: OriginInput): WallOrigin {
  const event = eventName(input.event)
  const clockAt = isIsoClock(input.clock) ? input.clock ?? null : null
  if (input.runtime === "demo" && !isArchive(input.source, event, input.clock)) {
    return {
      kind: "fixture",
      event: null,
      eventLabel: null,
      clock: "fixture",
      clockAt,
      chip: "DEMO",
      place: "Demo fixture",
      showScrubber: isLayoutFixture(input.runId),
    }
  }
  if (isArchive(input.source, event, input.clock)) {
    const eventLabel = event === null ? null : titleEvent(event)
    return {
      kind: "archive",
      event,
      eventLabel,
      clock: "archive",
      clockAt,
      chip: "ARCHIVE",
      place: eventLabel === null ? "ARCHIVE" : `ARCHIVE · ${eventLabel}`,
      showScrubber: false,
    }
  }
  return {
    kind: "live",
    event: null,
    eventLabel: null,
    clock: "wall",
    clockAt: null,
    chip: "LIVE",
    place: `Live · ${input.intervalLabel ?? "—"}`,
    showScrubber: false,
  }
}
