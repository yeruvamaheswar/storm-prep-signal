import { describe, expect, it } from "vitest"
import { oldestAsOf } from "../src/domain/age"
import { remainingChoices } from "../src/domain/attention"
import { parseHome, parsePlayback, parseTape, parseTick } from "../src/domain/parse"
import badFeed from "../src/fixtures/console/bad-feed.json"
import homes from "../src/fixtures/console/homes.json"
import liveOk from "../src/fixtures/console/live-ok.json"
import playbackOff from "../src/fixtures/console/playback-off.json"
import playbackState from "../src/fixtures/console/playback-state.json"
import playback from "../src/fixtures/console/playback.json"
import retrySpent from "../src/fixtures/console/retry-spent.json"
import stressReserve from "../src/fixtures/console/stress-reserve.json"
import tapes from "../src/fixtures/console/tapes.json"

describe("console fixtures", () => {
  it("parses each tick fixture", () => {
    expect(parseTick(liveOk)).toMatchObject({
      mode: "AUTO",
      source: "live",
      quality: "ok",
      attention: null,
      delivered_mw: 0.32,
    })
    expect(parseTick(liveOk).stress.calm_streak).toBe(2)
    expect(parseTick(liveOk).delivered_mw).toBeLessThan(parseTick(liveOk).target.mw)

    const reserve = parseTick(stressReserve)
    expect(reserve.mode).toBe("RESERVE")
    expect(reserve.delivered_mw).toBe(0)
    expect(reserve.stress.level).toBe("HIGH")
    expect(reserve.reserve.reason).toBe("stress_high")

    const feed = parseTick(badFeed)
    expect(feed.mode).toBe("RESERVE")
    expect(feed.quality).toBe("timeout")
    expect(feed.attention?.input).toBe("stress")
    expect(feed.attention?.retry_spent).toBe(false)
    expect(feed.attention?.choices).toContain("retry")

    const spent = parseTick(retrySpent)
    expect(spent.attention?.retry_spent).toBe(true)
    expect(spent.attention?.input).toBe("stress")

    const tapeTick = parseTick(playback)
    expect(tapeTick.source).toBe("playback")
    expect(tapeTick.tape_id).toBe("demo-stress")
  })

  it("parses homes, tapes, and playback", () => {
    const parsedHomes = homes.map(parseHome)
    expect(parsedHomes.map((home) => home.status)).toEqual(["live", "unconfirmed", "dead"])
    const live = parsedHomes[0]
    const unconfirmed = parsedHomes[1]
    const dead = parsedHomes[2]
    expect(live.soc_kwh).toBeGreaterThan(live.floor_kwh)
    expect(live.assigned_kw).toBeGreaterThan(0)
    expect(unconfirmed.skip_reason).toBe("unconfirmed")
    expect(unconfirmed.last_command?.ack).toBe("timeout")
    expect(dead.status).toBe("dead")

    const parsedTapes = tapes.map(parseTape)
    expect(parsedTapes).toHaveLength(1)
    expect(parsedTapes[0].labeled).toBe("synthetic")

    expect(parsePlayback(playbackState)).toEqual({
      tape_id: "demo-stress",
      tick_index: 4,
      tick_count: 12,
    })
    expect(parsePlayback(playbackOff)).toBeNull()
  })

  it("rejects a bad quality, a bad mode, and a missed_mw that is not target minus delivered", () => {
    const badQuality = structuredClone(liveOk) as { quality: string }
    badQuality.quality = "fine"
    expect(() => parseTick(badQuality)).toThrow(/quality/)

    const badMode = structuredClone(liveOk) as { mode: string }
    badMode.mode = "NORMAL"
    expect(() => parseTick(badMode)).toThrow(/mode/)

    const badMiss = structuredClone(liveOk)
    badMiss.missed_mw = 9
    expect(() => parseTick(badMiss)).toThrow(/missed_mw/)
  })

  it("rejects a tick whose breaches field is missing", () => {
    const tick = structuredClone(liveOk)
    const fleet = tick.fleet as { breaches?: number }
    delete fleet.breaches
    expect(() => parseTick(tick)).toThrow(/breaches/)
  })

  it("drops retry after retry_spent", () => {
    const open = parseTick(badFeed).attention
    const spent = parseTick(retrySpent).attention
    if (!open || !spent) throw new Error("expected attention")
    expect(remainingChoices(open)).toEqual(["approve", "retry", "skip"])
    expect(remainingChoices(spent)).toEqual(["approve", "skip"])
  })

  it("picks the earliest as_of among target, price, and stress", () => {
    const tick = parseTick(liveOk)
    expect(oldestAsOf(tick)).toBe("2026-07-08T19:00:00-05:00")

    const missing = structuredClone(tick)
    const price = missing.price as { as_of?: string }
    delete price.as_of
    expect(oldestAsOf(missing)).toBeNull()
  })
})
