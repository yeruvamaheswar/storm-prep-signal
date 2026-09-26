import { parseAttention, parseHome, parsePlayback, parseTape, parseTick, parseZone } from "../domain/parse"
import type { Attention, AttentionChoice, Home, HomeStatus, Playback, Tape, Tick, Zone } from "../domain/types"

export type LiveStreamEvent =
  | { type: "tick"; tick: Tick }
  | { type: "attention"; attention: Attention }
  | { type: "home"; home: Home }
  | { type: "error"; message: string }

export type ConsoleClient = {
  zone: () => Promise<Zone>
  live: () => Promise<Tick>
  homes: (status?: HomeStatus) => Promise<Home[]>
  home: (id: string) => Promise<Home>
  ticks: (range: { from: string; to: string }) => Promise<Tick[]>
  tick: (id: string) => Promise<Tick>
  tapes: () => Promise<Tape[]>
  playback: () => Promise<Playback | null>
  mode: (next: "HOLD" | "AUTO") => Promise<void>
  attention: (id: string, choice: AttentionChoice) => Promise<void>
  startPlayback: (tapeId: string) => Promise<void>
  stopPlayback: () => Promise<void>
  liveStream: (onEvent: (event: LiveStreamEvent) => void) => () => void
}

type FetchFn = typeof fetch

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isAbort(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("name" in err)) return false
  return err.name === "AbortError"
}

async function errorFrom(res: Response): Promise<Error> {
  if (res.status === 409) {
    const text = await res.text()
    if (text) {
      try {
        const body: unknown = JSON.parse(text)
        if (isRecord(body) && typeof body.brief === "string") {
          return new Error(body.brief)
        }
      } catch {
        return new Error(`request failed: ${res.status}`)
      }
    }
  }
  return new Error(`request failed: ${res.status}`)
}

function endpoint(baseUrl: string, suffix: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl
  return `${base}${suffix}`
}

type Frame = { event: string; data: string }

function parseFrame(raw: string): Frame | null {
  let event = "message"
  const dataLines: string[] = []
  for (const line of raw.split("\n")) {
    if (line.length === 0 || line.startsWith(":")) continue
    const splitAt = line.indexOf(":")
    if (splitAt === -1) continue
    const field = line.slice(0, splitAt)
    const value = line.slice(splitAt + 1).replace(/^ /, "")
    if (field === "event") event = value
    if (field === "data") dataLines.push(value)
  }
  if (dataLines.length === 0) return null
  return { event, data: dataLines.join("\n") }
}

function publishFrame(raw: string, onEvent: (event: LiveStreamEvent) => void): void {
  const frame = parseFrame(raw)
  if (!frame) return
  let payload: unknown
  try {
    payload = JSON.parse(frame.data)
  } catch (err) {
    const message = err instanceof Error ? err.message : "stream error"
    onEvent({ type: "error", message })
    return
  }
  try {
    if (frame.event === "tick") {
      onEvent({ type: "tick", tick: parseTick(payload) })
      return
    }
    if (frame.event === "attention") {
      onEvent({ type: "attention", attention: parseAttention(payload) })
      return
    }
    if (frame.event === "home") {
      onEvent({ type: "home", home: parseHome(payload) })
      return
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "stream error"
    onEvent({ type: "error", message })
  }
}

// baseUrl is the /v1 root (`/v1` or `http://host/v1`). Paths below are appended to it.
export function createClient(options: {
  fetch: FetchFn
  baseUrl: string
  operatorId: string
}): ConsoleClient {
  const { fetch: fetchFn, baseUrl, operatorId } = options

  async function getJson(suffix: string): Promise<unknown> {
    const res = await fetchFn(endpoint(baseUrl, suffix), {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json" },
    })
    if (!res.ok) throw await errorFrom(res)
    return (await res.json()) as unknown
  }

  async function post(suffix: string, body: unknown): Promise<void> {
    const res = await fetchFn(endpoint(baseUrl, suffix), {
      method: "POST",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Operator-Id": operatorId,
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw await errorFrom(res)
  }

  function list<T>(value: unknown, parseOne: (item: unknown) => T, label: string): T[] {
    if (!Array.isArray(value)) throw new Error(`expected ${label}`)
    return value.map(parseOne)
  }

  function liveStream(onEvent: (event: LiveStreamEvent) => void): () => void {
    const controller = new AbortController()
    // No last-tick cache. A stream failure is reported; the previous tick is not replayed as current.
    void (async () => {
      try {
        const res = await fetchFn(endpoint(baseUrl, "/live/stream"), {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
          headers: { Accept: "text/event-stream" },
        })
        if (!res.ok || !res.body) {
          onEvent({ type: "error", message: `live stream failed: ${res.status}` })
          return
        }
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read()
          if (done) {
            if (buffer.trim()) publishFrame(buffer, onEvent)
            return
          }
          buffer += decoder.decode(value, { stream: true })
          buffer = buffer.replace(/\r\n/g, "\n")
          const frames = buffer.split("\n\n")
          buffer = frames.pop() ?? ""
          for (const frame of frames) publishFrame(frame, onEvent)
        }
      } catch (err) {
        if (isAbort(err) || controller.signal.aborted) return
        const message = err instanceof Error ? err.message : "stream error"
        onEvent({ type: "error", message })
      }
    })()
    return () => controller.abort()
  }

  return {
    async zone() {
      return parseZone(await getJson("/zone"))
    },
    async live() {
      return parseTick(await getJson("/live"))
    },
    async homes(status?: HomeStatus) {
      const suffix =
        status === undefined ? "/homes" : `/homes?status=${encodeURIComponent(status)}`
      return list(await getJson(suffix), parseHome, "homes")
    },
    async home(id: string) {
      return parseHome(await getJson(`/homes/${encodeURIComponent(id)}`))
    },
    async ticks(range: { from: string; to: string }) {
      const suffix = `/ticks?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`
      return list(await getJson(suffix), parseTick, "ticks")
    },
    async tick(id: string) {
      return parseTick(await getJson(`/ticks/${encodeURIComponent(id)}`))
    },
    async tapes() {
      return list(await getJson("/tapes"), parseTape, "tapes")
    },
    async playback() {
      return parsePlayback(await getJson("/playback"))
    },
    mode(next: "HOLD" | "AUTO") {
      return post("/fleet/mode", { mode: next })
    },
    attention(id: string, choice: AttentionChoice) {
      return post(`/attention/${encodeURIComponent(id)}`, { choice })
    },
    startPlayback(tapeId: string) {
      return post("/playback", { tape_id: tapeId })
    },
    stopPlayback() {
      return post("/playback/stop", {})
    },
    liveStream,
  }
}
