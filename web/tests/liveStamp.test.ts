import { describe, expect, it, vi } from "vitest"
import layoutRun from "../src/fixtures/layout-run.json"
import type { RunFile, TickView } from "../src/contracts"
import {
  EMPTY_WATCH,
  LIVE_POLL_MS,
  fetchSnapshot,
  intervalDraftFromTick,
  pushLiveInterval,
  rememberLive,
  rememberSnapshot,
  stampFromSnapshot,
  stampTick,
  viewTick,
} from "../src/liveStamp"
import { stressReading } from "../src/stressReading"

const run = layoutRun as RunFile

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })
}

describe("live stamp", () => {
  it("polls the API every 20 seconds, not ERCOT", () => {
    expect(LIVE_POLL_MS).toBe(20_000)
  })

  it("reads /v1/snapshot instead of calling ERCOT", async () => {
    const payload = {
      tick: 12,
      ts: "2024-07-08T14:55:00-05:00",
      target_mw: 0.2,
      delivered_mw: 0.2,
      missed_mw: 0,
      price_usd_mwh: 42.25,
      outage_mw: 20200,
      driving_zone: "North",
      zone_mw: 9000,
      as_of: "23:00 CT",
      stress_age_min: 30,
      quality: "ok",
      totalResourceMWZoneNorth: 8000,
    }
    const fetchFn = vi.fn<typeof fetch>(async () => json(payload))
    const pull = await fetchSnapshot(fetchFn, "")
    expect(pull.stamp).toMatchObject({
      quality: "ok",
      priceUsdMwh: 42.25,
      outageMw: 20200,
      zone: "North",
      asOfLabel: "23:00 CT",
    })
    expect(pull.tick).toMatchObject({ tick: 12, target_mw: 0.2, delivered_mw: 0.2 })
    expect(String(vi.mocked(fetchFn).mock.calls[0][0])).toBe("/v1/snapshot")
    expect(String(vi.mocked(fetchFn).mock.calls[0][0])).not.toContain("api.ercot.com")
    await fetchSnapshot(fetchFn, "", 8000, { event: "beryl", clock: "2024-07-08T14:20:00-05:00" })
    expect(String(vi.mocked(fetchFn).mock.calls[1][0])).toContain("/v1/snapshot?event=beryl&clock=")
    expect(stampFromSnapshot({ quality: "auth" })).toMatchObject({
      quality: "auth",
      reservePct: 60,
      risk: null,
      policyReason: "signal_unavailable",
    })
  })

  it("reads the v2 trigger and fail-safe policy from /v1/snapshot", () => {
    const stamp = stampFromSnapshot({
      quality: "ok",
      price_usd_mwh: 42.25,
      outage_mw: 23539,
      peak_mw: 23539,
      trigger_mw: 23263.35,
      margin_mw: 275.65,
      driving_zone: "North",
      zone_mw: 9294,
      as_of: "12:00 CT",
      stress_age_min: 0,
      reserve_pct: 60,
      risk_level: "HIGH",
      policy_reason: "storm_risk_high",
    })
    expect(stamp).toMatchObject({
      quality: "ok",
      outageMw: 23539,
      triggerMw: 23263.35,
      peakMw: 23539,
      reservePct: 60,
      risk: "HIGH",
      policyReason: "storm_risk_high",
    })
    const fail = stampFromSnapshot({
      quality: "stale",
      reserve_pct: 60,
      risk_level: null,
      policy_reason: "signal_unavailable",
    })
    expect(fail).toMatchObject({
      quality: "stale",
      reservePct: 60,
      risk: null,
      policyReason: "signal_unavailable",
    })
  })

  it("keeps the v2 trigger when archive price is missing", () => {
    const stamp = stampFromSnapshot({
      quality: "ok",
      price_usd_mwh: null,
      outage_mw: 22194,
      peak_mw: 22194,
      trigger_mw: 23304,
      driving_zone: "North",
      zone_mw: 9429,
      as_of: "12:00 CT",
      stress_age_min: 0,
      reserve_pct: 30,
      risk_level: "LOW",
      policy_reason: "normal",
    })
    expect(stamp).toMatchObject({
      quality: "ok",
      priceUsdMwh: null,
      triggerMw: 23304,
      peakMw: 22194,
      policyReason: "normal",
    })
  })

  it("keeps the last successful as-of when a later pull fails", () => {
    const tape = run.ticks[4] as TickView
    const ok = {
      quality: "ok" as const,
      priceUsdMwh: 42,
      outageMw: 19000,
      zone: "North" as const,
      zoneMw: 9000,
      zoneColumns: {},
      asOfLabel: "14:00 CT",
      ageMin: 12,
    }
    const watched = rememberLive(rememberLive(EMPTY_WATCH, ok), { quality: "timeout" })
    expect(watched.lastOk).toEqual(ok)
    const tick = viewTick(tape, watched)
    expect(stressReading(tick)).toMatchObject({
      asOfLabel: "14:00 CT",
      ageMin: 12,
      clockPinned: false,
      quality: "timeout",
    })
  })

  it("clears tape 185 and the tape trigger on a failed pull", () => {
    const tape = run.ticks[4] as TickView
    const tick = stampTick(tape, { quality: "timeout" })
    expect(tick.price_usd_mwh).toBeNull()
    expect(tick.trigger_mw).toBeNull()
    expect(tick.risk_level).toBeNull()
    expect(tick.reserve_pct).toBe(60)
    expect(tick.target_mw).toBe(tape.target_mw)
    expect(stressReading(tick).quality).toBe("timeout")
  })

  it("stamps price, outage, zone, and as-of, and leaves the target on the tape", () => {
    const tape = run.ticks[4] as TickView
    const tick = stampTick(tape, {
      quality: "ok",
      priceUsdMwh: 42.25,
      outageMw: 20200,
      zone: "North",
      zoneMw: 9000,
      zoneColumns: {
        totalResourceMWZoneNorth: 8000,
        totalIRRMWZoneNorth: 700,
        totalNewEquipResourceMWZoneNorth: 300,
      },
      asOfLabel: "23:00 CT",
      ageMin: 30,
    })
    expect(tick.target_mw).toBe(tape.target_mw)
    expect(tick.target_label).toBe(tape.target_label)
    expect(tick.price_usd_mwh).toBe(42.25)
    const reading = stressReading(tick)
    expect(reading).toMatchObject({ outageMw: 20200, zone: "North", zoneMw: 9000, quality: "ok", clockPinned: false })
    expect(reading.thresholdMw).toBeNull()
    expect(tick.zone_mw).toBe(9000)
  })

  it("stores the snapshot tick and rolls intervals without using a tape index", () => {
    const first = run.ticks[0] as TickView
    const second = { ...(run.ticks[1] as TickView), ts: "2024-07-08T15:10:00-05:00" }
    const watched = rememberSnapshot(EMPTY_WATCH, { quality: "ok", priceUsdMwh: 1, outageMw: 1, zone: "North", zoneMw: 1, zoneColumns: {}, asOfLabel: "15:00 CT", ageMin: 1 }, first)
    const next = rememberSnapshot(watched, { quality: "auth" }, second)
    expect(next.tick?.tick).toBe(second.tick)
    expect(next.intervals).toHaveLength(2)
    expect(next.intervals?.[0]?.targetMw).toBe(first.target_mw)
    expect(next.intervals?.[1]?.targetMw).toBe(second.target_mw)
  })

  it("keeps the snapshot engine mode on the live tick", () => {
    const tick = { ...(run.ticks[4] as TickView), mode: "HOLD" as const }
    const watched = rememberSnapshot(
      EMPTY_WATCH,
      {
        quality: "ok",
        priceUsdMwh: 42,
        outageMw: 19000,
        zone: "North",
        zoneMw: 9000,
        zoneColumns: {},
        asOfLabel: "14:00 CT",
        ageMin: 12,
      },
      tick,
    )
    expect(watched.tick?.mode).toBe("HOLD")
  })

  it("replaces the last interval when the snapshot ts does not move", () => {
    const tick = run.ticks[0] as TickView
    const first = pushLiveInterval([], null, tick)
    const updated = { ...tick, delivered_mw: 0.11 }
    const second = pushLiveInterval(first.intervals, first.lastDraft, updated)
    expect(second.intervals).toHaveLength(1)
    expect(second.intervals[0]?.deliveredMw).toBe(0.11)
    expect(intervalDraftFromTick(updated).reservedMw).toBe(0)
  })
})
