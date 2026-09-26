import layoutRun from "./fixtures/layout-run.json"
import type { RunFile } from "./contracts"

function isRunFile(value: unknown): value is RunFile {
  if (value === null || typeof value !== "object") {
    return false
  }
  const run = value as RunFile
  return typeof run.run_id === "string" && Array.isArray(run.ticks) && run.ticks.length > 0
}

export async function loadRun(): Promise<RunFile> {
  try {
    const response = await fetch("/runs/latest.json")
    if (!response.ok) {
      return layoutRun as RunFile
    }
    const body: unknown = await response.json()
    if (!isRunFile(body)) {
      return layoutRun as RunFile
    }
    return body
  } catch {
    return layoutRun as RunFile
  }
}

export function stormTickIndex(run: RunFile): number {
  const index = run.ticks.findIndex((tick) => tick.missed_mw > 0)
  return index >= 0 ? index : 0
}
