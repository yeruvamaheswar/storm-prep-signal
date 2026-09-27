import type { ScenarioList, StateReply } from "./types"

type FetchFn = typeof fetch

const TIMEOUT_MS = 3000
export const OPERATOR_ID = "operator-demo"

export type FlowRequest =
  | { kind: "start"; body: { scenario: string; seed?: number } }
  | { kind: "reset"; body: { seed?: number } }
  | { kind: "play"; body: { playing: boolean } }
  | { kind: "speed"; body: { x: number } }
  | { kind: "alert"; body: { alert_id: string } }
  | { kind: "grid-down"; body: { zone: string; down: boolean } }
  | { kind: "step"; body: Record<string, never> }
  /** Task 16: go to tick index N (ticks played) by re-running the engine; the worker clamps N. Task 14B fix round 2:
   * or `delta` ticks from the worker's live index, resolved when it applies it (key steps and 1-hour buttons while
   * playing). */
  | { kind: "seek"; body: SeekBody }

export type SeekBody = { tick: number } | { delta: number }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function getJson(fetchFn: FetchFn, url: string): Promise<unknown> {
  const res = await fetchFn(url, {
    method: "GET",
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`http ${res.status}`)
  return res.json()
}

export async function fetchScenarios(fetchFn: FetchFn, base: string): Promise<ScenarioList> {
  const body = await getJson(fetchFn, `${base}/v1/scenarios`)
  if (!isRecord(body) || !Array.isArray(body.scenarios)) throw new Error("bad_payload")
  return body as ScenarioList
}

export async function fetchState(fetchFn: FetchFn, base: string): Promise<StateReply> {
  const body = await getJson(fetchFn, `${base}/v1/scenario/state`)
  if (!isRecord(body) || typeof body.status !== "string") throw new Error("bad_payload")
  return body as StateReply
}

/** Records one request. The session worker applies it on its next loop; the reply is not the result. Resolves to the
 * request's seq from the reply (`accepted`), or null when the reply does not say. */
export async function sendRequest(fetchFn: FetchFn, base: string, request: FlowRequest): Promise<number | null> {
  const res = await fetchFn(`${base}/v1/scenario/${request.kind}`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-Operator-Id": OPERATOR_ID },
    body: JSON.stringify(request.body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) {
    let brief = `http ${res.status}`
    try {
      const body: unknown = await res.json()
      if (isRecord(body) && typeof body.brief === "string") brief = body.brief
    } catch {
      // Keep the status text when the body is not JSON.
    }
    throw new Error(brief)
  }
  try {
    const body: unknown = await res.json()
    return isRecord(body) && typeof body.accepted === "number" ? body.accepted : null
  } catch {
    return null
  }
}
