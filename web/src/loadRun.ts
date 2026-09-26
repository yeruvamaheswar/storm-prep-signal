import { apiBaseUrl } from "./api/health"
import type { RunFile, WallMeta } from "./contracts"
import layoutRun from "./fixtures/layout-run.json"
import type { RuntimeMode } from "./runtimeMode"
import { preferredMode } from "./runtimeMode"

function isRunFile(value: unknown): value is RunFile {
  if (value === null || typeof value !== "object") {
    return false
  }
  const run = value as RunFile
  return typeof run.run_id === "string" && Array.isArray(run.ticks) && run.ticks.length > 0
}

type RunsTableRow = {
  run_id?: unknown
  source?: unknown
  result?: unknown
}

/** Empty PostgREST /runs is not a run. The snapshot file stays the source of truth. */
export function runFromTableRows(value: unknown): RunFile | null {
  const rows = Array.isArray(value) ? value : value !== null && typeof value === "object" ? [value] : []
  if (rows.length === 0) {
    return null
  }
  const row = rows[0]
  if (row === null || typeof row !== "object") {
    return null
  }
  const record = row as RunsTableRow
  const result = record.result
  if (typeof result === "string") {
    return null
  }
  if (isRunFile(result)) {
    return result
  }
  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    const payload = result as RunFile
    const runId = typeof payload.run_id === "string" ? payload.run_id : record.run_id
    if (typeof runId === "string" && Array.isArray(payload.ticks) && payload.ticks.length > 0) {
      return { ...payload, run_id: runId }
    }
  }
  if (Array.isArray(result) && result.length > 0 && typeof record.run_id === "string") {
    const candidate: RunFile = {
      run_id: record.run_id,
      decision_line: null,
      ticks: result,
      ...(typeof record.source === "string" ? { source: record.source } : {}),
    }
    if (isRunFile(candidate)) {
      return candidate
    }
  }
  return isRunFile(row) ? row : null
}

/** File wins. Table rows count only when they exist. Empty [] uses the layout tape. */
export function pickRun(tableRows: unknown, file: RunFile | null = null): RunFile {
  if (file !== null && isRunFile(file)) {
    return file
  }
  return runFromTableRows(tableRows) ?? (layoutRun as RunFile)
}

function isWallMeta(value: unknown): value is WallMeta {
  if (value === null || typeof value !== "object") {
    return false
  }
  const meta = value as WallMeta
  return (meta.mode === "live" || meta.mode === "demo") && typeof meta.fleet_size === "number" && typeof meta.source === "string"
}

function readWallMeta(value: unknown): WallMeta | null {
  if (!isWallMeta(value)) return null
  return {
    mode: value.mode,
    fleet_size: value.fleet_size,
    source: value.source,
    event: typeof value.event === "string" && value.event.trim() !== "" ? value.event : null,
    clock: typeof value.clock === "string" && value.clock.trim() !== "" ? value.clock : null,
    fleet_cap_mw: typeof value.fleet_cap_mw === "number" ? value.fleet_cap_mw : undefined,
    call_target_mw: typeof value.call_target_mw === "number" ? value.call_target_mw : undefined,
  }
}

/** Query string wins, then VITE_DEFAULT_MODE. Null means use GET /v1/meta. */
export function requestedMode(
  search = typeof window === "undefined" ? "" : window.location.search,
  env: string | undefined = import.meta.env.VITE_DEFAULT_MODE,
): RuntimeMode | null {
  return preferredMode(new URLSearchParams(search).get("mode"), env)
}

const ARCHIVE_EVENTS = ["beryl", "heather", "tuning-2026"] as const

export type ArchiveEvent = (typeof ARCHIVE_EVENTS)[number]

/** `?event=beryl|heather|tuning-2026`. `none` keeps the layout tape. */
export function requestedEvent(
  search = typeof window === "undefined" ? "" : window.location.search,
): ArchiveEvent | null {
  const value = new URLSearchParams(search).get("event")
  if (value === "none" || value === "fixture") return null
  return ARCHIVE_EVENTS.find((name) => name === value) ?? null
}

/** `?event=none` or `?event=fixture` keeps the 12-tick tape. */
export function wantsLayoutTape(
  search = typeof window === "undefined" ? "" : window.location.search,
): boolean {
  const value = new URLSearchParams(search).get("event")
  return value === "none" || value === "fixture"
}

/** Demo click defaults to beryl. `?event=none` keeps the tape. Live uses meta. */
export function resolveWallEvent(
  search: string,
  demoChosen: boolean,
  metaEvent: string | null | undefined,
): ArchiveEvent | null {
  if (wantsLayoutTape(search)) return null
  const named = requestedEvent(search)
  if (named) return named
  if (demoChosen) return "beryl"
  return isArchiveEvent(metaEvent) ? metaEvent : null
}

export function isArchiveEvent(value: string | null | undefined): value is ArchiveEvent {
  return value === "beryl" || value === "heather" || value === "tuning-2026"
}

export async function loadMeta(fetchFn: typeof fetch = fetch, baseUrl = apiBaseUrl()): Promise<WallMeta | null> {
  try {
    const response = await fetchFn(`${baseUrl}/v1/meta`, { cache: "no-store", headers: { Accept: "application/json" } })
    if (!response.ok) return null
    const body: unknown = await response.json()
    return readWallMeta(body)
  } catch {
    return null
  }
}

/** Demo tape only. Live numbers come from GET /v1/snapshot, never this file. */
export async function loadRun(): Promise<RunFile> {
  return layoutRun as RunFile
}

export function stormTickIndex(run: RunFile): number {
  const index = run.ticks.findIndex((tick) => tick.missed_mw > 0)
  return index >= 0 ? index : 0
}

/** Kept for tests that still fetch /v1/runs/latest. Demo does not call this. */
export async function loadEngineRun(fetchFn: typeof fetch = fetch, baseUrl = apiBaseUrl()): Promise<RunFile | null> {
  try {
    const response = await fetchFn(`${baseUrl}/v1/runs/latest`)
    if (!response.ok) return null
    const body: unknown = await response.json()
    if (Array.isArray(body)) {
      return runFromTableRows(body)
    }
    return isRunFile(body) ? body : null
  } catch {
    return null
  }
}
