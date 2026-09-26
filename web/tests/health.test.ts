import { describe, expect, it, vi } from "vitest"
import { apiBaseUrl, checkHealth, healthText } from "../src/api/health"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

describe("apiBaseUrl", () => {
  it("is same origin when unset and drops a trailing slash", () => {
    expect(apiBaseUrl(undefined)).toBe("")
    expect(apiBaseUrl("https://api.example/")).toBe("https://api.example")
  })
})

describe("checkHealth", () => {
  it("calls /health on the base URL and reads ok", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }))
    expect(await checkHealth(fetchMock, "https://api.example")).toEqual({ state: "ok" })
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.example/health")
  })

  it("reports an HTTP failure", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({}, 503))
    expect(await checkHealth(fetchMock, "")).toEqual({ state: "down", reason: "http 503" })
  })

  it("rejects a body without ok: true", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: "yes" }))
    expect(await checkHealth(fetchMock, "")).toEqual({ state: "down", reason: "bad_payload" })
  })

  it("names a timeout and a refused connection", async () => {
    const timeout = vi.fn<typeof fetch>(async () => {
      throw new DOMException("slow", "TimeoutError")
    })
    const refused = vi.fn<typeof fetch>(async () => {
      throw new TypeError("Failed to fetch")
    })
    expect(await checkHealth(timeout, "")).toEqual({ state: "down", reason: "timeout" })
    expect(await checkHealth(refused, "")).toEqual({ state: "down", reason: "unreachable" })
  })
})

describe("healthText", () => {
  it("says what the mast shows", () => {
    expect(healthText({ state: "checking" })).toBe("api checking")
    expect(healthText({ state: "ok" })).toBe("api ok")
    expect(healthText({ state: "down", reason: "timeout" })).toBe("api down · timeout")
  })
})
