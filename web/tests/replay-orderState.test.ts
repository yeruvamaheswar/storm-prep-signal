import { describe, expect, test } from "vitest"
import type { OrderTimelineEntry } from "../src/features/flow/types"
import { homeOrderState, splitOrders, stateColor, stateLabel } from "../src/features/replay/orderState"

const northTick3: Record<string, OrderTimelineEntry[]> = {
  "home-054": [
    [0, "sent", 0.01],
    [9.4, "exec", 0.01],
    [9.4, "rdrop", null],
    [60, "retry", null],
    [74.8, "dup", null],
    [74.8, "rdrop", null],
  ],
  "home-066": [
    [0, "sent", 2.11],
    [0, "drop", null],
    [60, "retry", null],
    [80.7, "exec", 2.11],
    [82.3, "conf", 2.11],
  ],
  "home-070": [
    [0, "sent", 5],
    [0, "drop", null],
    [60, "retry", null],
    [60, "drop", null],
  ],
}

describe("homeOrderState", () => {
  test("follows the mockup state transitions for a retry that gives energy but never confirms", () => {
    expect(homeOrderState(northTick3["home-054"], 0)).toMatchObject({ s: "out", gave: false, retried: false, dup: false })
    expect(homeOrderState(northTick3["home-054"], 9.4)).toMatchObject({ s: "rlost", gave: true })
    expect(homeOrderState(northTick3["home-054"], 60)).toMatchObject({ s: "wait", retried: true })
    expect(homeOrderState(northTick3["home-054"], 74.8)).toMatchObject({ s: "rlost", dup: true })
    expect(homeOrderState(northTick3["home-054"], 120)).toMatchObject({ s: "nc", gave: true })
  })

  test("counts a confirmed retry as ok at the real North tick-3 confirmation time", () => {
    expect(homeOrderState(northTick3["home-066"], 59.9).s).toBe("lost")
    expect(homeOrderState(northTick3["home-066"], 80.7)).toMatchObject({ s: "wait", gave: true, retried: true })
    expect(homeOrderState(northTick3["home-066"], 82.3)).toMatchObject({ s: "ok", gave: true })
    expect(homeOrderState(northTick3["home-066"], 125).s).toBe("ok")
  })

  test("marks an unanswered lost retry as not counted after close", () => {
    expect(homeOrderState(northTick3["home-070"], 0)).toMatchObject({ s: "lost", gave: false })
    expect(homeOrderState(northTick3["home-070"], 60)).toMatchObject({ s: "lost", retried: true })
    expect(homeOrderState(northTick3["home-070"], 120)).toMatchObject({ s: "nc", gave: false })
  })

  test("records charging orders while keeping mockup labels and ok confirmation", () => {
    const chargeOrder: OrderTimelineEntry[] = [
      [0, "sent", -3],
      [8, "exec", -3],
      [13, "conf", -3],
    ]
    // A charge order never "gave" energy: gave stays false, charging is true.
    const state = homeOrderState(chargeOrder, 13)
    expect(state).toMatchObject({ s: "ok", gave: false, charging: true })
    expect(stateLabel(state, -3)).toBe("Charge confirmed")
  })

  test("a charge exec leaves state wait with gave false, labelled as charging", () => {
    const chargeOrder: OrderTimelineEntry[] = [
      [0, "sent", -3],
      [8, "exec", -3],
    ]
    const state = homeOrderState(chargeOrder, 10)
    expect(state).toMatchObject({ s: "wait", gave: false, charging: true })
    expect(stateLabel(state)).toBe("Charging, waiting for its report")
    expect(stateLabel(state)).not.toContain("Gave")
  })

  test("a charge ok reads 'Charge confirmed' from the state alone", () => {
    const state = homeOrderState([[0, "sent", -2], [5, "exec", -2], [9, "conf", -2]], 20)
    expect(stateLabel(state)).toBe("Charge confirmed")
  })

  test("a charge nc reads 'Charge not confirmed, not counted' from the state alone", () => {
    const state = homeOrderState([[0, "sent", -2], [5, "exec", -2]], 120)
    expect(state).toMatchObject({ s: "nc", gave: false, charging: true })
    expect(stateLabel(state)).toBe("Charge not confirmed, not counted")
  })

  test("splits own and reassigned order keys, defaulting missing keys to own", () => {
    const mixed: OrderTimelineEntry[] = [
      [0, "sent", 4],
      [60, "retry", null, "own"],
      [61, "reassigned", "home-022", "r"],
      [63, "exec", 1.5, "r"],
    ]
    expect(splitOrders(mixed)).toEqual({
      own: [
        [0, "sent", 4],
        [60, "retry", null, "own"],
      ],
      r: [
        [61, "reassigned", "home-022", "r"],
        [63, "exec", 1.5, "r"],
      ],
    })
  })

  test("splitOrders treats any key other than 'r' as own", () => {
    const weird = [[0, "sent", 4, "bogus"]] as unknown as OrderTimelineEntry[]
    expect(splitOrders(weird)).toEqual({ own: weird, r: [] })
  })

  test("conf does not set gave; only exec does", () => {
    const confOnly: OrderTimelineEntry[] = [
      [0, "sent", 4],
      [20, "conf", 4],
    ]
    expect(homeOrderState(confOnly, 20)).toMatchObject({ s: "ok", gave: false })
  })

  test("a charge order's nc label reads 'Charge not confirmed, not counted'", () => {
    const chargeNeverConfirmed: OrderTimelineEntry[] = [
      [0, "sent", -3],
      [8, "exec", -3],
    ]
    const state = homeOrderState(chargeNeverConfirmed, 120)
    expect(state.s).toBe("nc")
    expect(stateLabel(state, -3)).toBe("Charge not confirmed, not counted")
  })

  test("returns the mockup labels and token color values", () => {
    expect(stateLabel({ s: "nc", gave: true, retried: true, dup: false }, 5)).toBe("Gave energy, not counted")
    expect(stateLabel({ s: "nc", gave: false, retried: true, dup: false }, 5)).toBe("No answer, not counted")
    expect(stateColor("lost")).toBe("var(--rg-lost)")
    expect(stateColor("ok")).toBe("var(--rg-confirmed)")
  })
})
