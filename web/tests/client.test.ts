import { describe, expect, it, vi } from "vitest"
import { createClient } from "../src/api/client"
import { parseTick } from "../src/domain/parse"
import liveOk from "../src/fixtures/console/live-ok.json"

const BASE = "http://ops.example/v1"
const OPERATOR = "op-14"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

describe("createClient", () => {
  it("sends X-Operator-Id on fleet mode and attention posts", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
    const client = createClient({ fetch: fetchMock, baseUrl: BASE, operatorId: OPERATOR })

    await client.mode("HOLD")
    await client.attention("att_01H", "approve")

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [modeUrl, modeInit] = fetchMock.mock.calls[0]
    const [attentionUrl, attentionInit] = fetchMock.mock.calls[1]
    expect(modeUrl).toBe(`${BASE}/fleet/mode`)
    expect(attentionUrl).toBe(`${BASE}/attention/att_01H`)
    expect(modeInit?.method).toBe("POST")
    expect(attentionInit?.method).toBe("POST")
    expect(modeInit?.headers).toMatchObject({ "X-Operator-Id": OPERATOR })
    expect(attentionInit?.headers).toMatchObject({ "X-Operator-Id": OPERATOR })
    expect(modeInit?.body).toBe(JSON.stringify({ mode: "HOLD" }))
    expect(attentionInit?.body).toBe(JSON.stringify({ choice: "approve" }))
  })

  it("throws the 409 brief as the error message", async () => {
    const brief = "Hold is refused while a tape is running."
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ error: "playback_active", brief }, 409),
    )
    const client = createClient({ fetch: fetchMock, baseUrl: BASE, operatorId: OPERATOR })

    await expect(client.mode("AUTO")).rejects.toThrow(brief)
    await expect(client.attention("att_01H", "retry")).rejects.toEqual(
      expect.objectContaining({ message: brief }),
    )
  })

  it("yields a parsed tick from an SSE tick frame", async () => {
    const frame = `event: tick\ndata: ${JSON.stringify(liveOk)}\n\n`
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame))
        controller.close()
      },
    })
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(stream, { status: 200 }))
    const client = createClient({ fetch: fetchMock, baseUrl: BASE, operatorId: OPERATOR })

    const event = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for tick")), 1000)
      const stop = client.liveStream((next) => {
        clearTimeout(timer)
        stop()
        resolve(next)
      })
    })

    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE}/live/stream`,
      expect.objectContaining({ method: "GET" }),
    )
    expect(event).toEqual({ type: "tick", tick: parseTick(liveOk) })
  })

  it("tells the caller when the live stream errors", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new Error("socket closed")
    })
    const client = createClient({ fetch: fetchMock, baseUrl: BASE, operatorId: OPERATOR })

    const event = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for stream error")), 1000)
      client.liveStream((next) => {
        clearTimeout(timer)
        resolve(next)
      })
    })

    expect(event).toEqual({ type: "error", message: "socket closed" })
  })
})
