import { useEffect, useState } from "react"

export type ApiHealth =
  | { state: "checking" }
  | { state: "ok" }
  | { state: "down"; reason: string }

type FetchFn = typeof fetch

const TIMEOUT_MS = 3000
const POLL_MS = 30_000

// Empty means same origin: the Vite dev server proxies /health and /v1 to the local API.
export function apiBaseUrl(raw: string | undefined = import.meta.env.VITE_API_BASE_URL): string {
  const base = (raw ?? "").trim()
  return base.endsWith("/") ? base.slice(0, -1) : base
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function failureReason(err: unknown): string {
  if (typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError") {
    return "timeout"
  }
  return "unreachable"
}

export async function checkHealth(
  fetchFn: FetchFn,
  baseUrl: string,
  timeoutMs = TIMEOUT_MS,
): Promise<ApiHealth> {
  try {
    const res = await fetchFn(`${baseUrl}/health`, {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return { state: "down", reason: `http ${res.status}` }
    const body: unknown = await res.json()
    if (isRecord(body) && body.ok === true) return { state: "ok" }
    return { state: "down", reason: "bad_payload" }
  } catch (err) {
    return { state: "down", reason: failureReason(err) }
  }
}

export function healthText(health: ApiHealth): string {
  switch (health.state) {
    case "checking":
      return "api checking"
    case "ok":
      return "api ok"
    case "down":
      return `api down · ${health.reason}`
    default: {
      const unreachable: never = health
      return unreachable
    }
  }
}

// Polls so the mast recovers on its own when the API starts after the wall.
export function useApiHealth(): ApiHealth {
  const [health, setHealth] = useState<ApiHealth>({ state: "checking" })

  useEffect(() => {
    let cancelled = false
    const base = apiBaseUrl()
    async function poll() {
      const next = await checkHealth(fetch, base)
      if (!cancelled) setHealth(next)
    }
    void poll()
    const timer = setInterval(() => void poll(), POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  return health
}
