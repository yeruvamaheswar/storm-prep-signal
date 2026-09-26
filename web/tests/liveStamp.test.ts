import { describe, expect, it, vi } from "vitest"
import layoutRun from "../src/fixtures/layout-run.json"
import type { RunFile, TickView } from "../src/contracts"
import { fetchLiveStamp, stampTick, type LiveOptions } from "../src/liveStamp"
import { stressReading } from "../src/stressReading"
import { zonePaint } from "../src/zonePaint"

const run = layoutRun as RunFile
const NOW = Date.parse("2026-09-25T23:30:00-05:00")

const ZONE_FIELDS = ["South", "North", "West", "Houston"].flatMap((zone) =>
  ["Resource", "IRR", "NewEquipResource"].map((category) => `total${category}MWZone${zone}`),
)

function body(names: string[], data: unknown[][]): unknown {
  return { fields: names.map((name) => ({ name })), data }
}

function spp(rows: unknown[][]): unknown {
  return body(["deliveryDate", "deliveryHour", "deliveryInterval", "settlementPoint", "settlementPointPrice"], rows)
}

function np3(posted: string, rows: unknown[][]): unknown {
  return body(["postedDatetime", "operatingDate", "hourEnding", ...ZONE_FIELDS], rows.map((row) => [posted, ...row]))
}

// South, North, West, Houston; three categories each. North is largest at 9,000 MW.
const NEXT_HOUR = ["2026-09-26", 1, 4000, 500, 300, 8000, 700, 300, 2500, 300, 100, 3000, 400, 100]
const LATER_HOUR = ["2026-09-26", 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })
}

function fakeFetch(price: () => Response, outage: () => Response): typeof fetch {
  return vi.fn<typeof fetch>(async (input) => (String(input).includes("np6-905-cd") ? price() : outage()))
}

function options(fetchFn: typeof fetch, extra: Partial<LiveOptions> = {}): LiveOptions {
  return { fetch: fetchFn, subscriptionKey: "key", idToken: "token", now: NOW, ...extra }
}

const goodPrice = () =>
  json(spp([["2026-09-25", 23, 4, "LZ_NORTH", 31.5], ["2026-09-25", 24, 1, "LZ_NORTH", 42.25]]))
const goodOutage = () => json(np3("2026-09-25T23:00:47", [NEXT_HOUR, LATER_HOUR]))

describe("live stamp", () => {
  it("reads the newest LZ_NORTH price and the next-hour outage posting", async () => {
    const fetchFn = fakeFetch(goodPrice, goodOutage)
    const stamp = await fetchLiveStamp(options(fetchFn))
    expect(stamp).toMatchObject({
      quality: "ok",
      priceUsdMwh: 42.25,
      outageMw: 20200,
      zone: "North",
      zoneMw: 9000,
      asOfLabel: "23:00 CT",
      ageMin: 30,
    })
    const [url, init] = vi.mocked(fetchFn).mock.calls[0]
    expect(String(url)).toContain("settlementPoint=LZ_NORTH")
    expect(init?.headers).toMatchObject({ Authorization: "Bearer token", "Ocp-Apim-Subscription-Key": "key" })
  })

  it("stamps price, outage, zone, and as-of, and leaves the target on the tape", async () => {
    const stamp = await fetchLiveStamp(options(fakeFetch(goodPrice, goodOutage)))
    const tape = run.ticks[4] as TickView
    const tick = stampTick(tape, stamp)
    expect(tick.target_mw).toBe(tape.target_mw)
    expect(tick.target_label).toBe(tape.target_label)
    expect(tick.price_usd_mwh).toBe(42.25)
    const reading = stressReading(tick)
    expect(reading).toMatchObject({ outageMw: 20200, zone: "North", zoneMw: 9000, quality: "ok", clockPinned: false })
    expect(reading.thresholdMw).toBeNull()
    expect(zonePaint(tick).zones.find((zone) => zone.zone === "North")?.mw).toBe(9000)
  })

  it("names auth when credentials are missing, without calling ERCOT", async () => {
    const fetchFn = fakeFetch(goodPrice, goodOutage)
    expect(await fetchLiveStamp(options(fetchFn, { idToken: undefined }))).toEqual({ quality: "auth" })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it("names auth on a 401", async () => {
    const stamp = await fetchLiveStamp(options(fakeFetch(() => json({}, 401), goodOutage)))
    expect(stamp).toEqual({ quality: "auth" })
  })

  it("names timeout when ERCOT does not answer", async () => {
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
      })
    const stamp = await fetchLiveStamp(options(hang, { timeoutMs: 5 }))
    expect(stamp).toEqual({ quality: "timeout" })
  })

  it("names stale when the newest price interval is old", async () => {
    const oldPrice = () => json(spp([["2026-09-25", 22, 1, "LZ_NORTH", 30]]))
    expect(await fetchLiveStamp(options(fakeFetch(oldPrice, goodOutage)))).toEqual({ quality: "stale" })
  })

  it("names stale when the outage posting is old", async () => {
    const oldOutage = () => json(np3("2026-09-25T20:00:12", [NEXT_HOUR]))
    expect(await fetchLiveStamp(options(fakeFetch(goodPrice, oldOutage)))).toEqual({ quality: "stale" })
  })

  it("keeps every tape number on a failure and only names the reason", () => {
    const tape = run.ticks[4] as TickView
    const before = stressReading(tape)
    const tick = stampTick(tape, { quality: "timeout" })
    expect(tick.price_usd_mwh).toBe(tape.price_usd_mwh)
    expect(stressReading(tick)).toEqual({ ...before, quality: "timeout" })
    expect(zonePaint(tick)).toEqual(zonePaint(tape))
  })
})
