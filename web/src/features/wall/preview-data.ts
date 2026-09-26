import type { HomeStatus, RecentTick, Tick, WallHome, Zone } from "./types"

// Three reviewer states. main.tsx only swaps which one is passed into WallPage.

export const previewIds = ["surplus", "stress", "attention"] as const

export type PreviewId = (typeof previewIds)[number]

export type PreviewState = {
  label: string
  zone: Zone
  tick: Tick
  recentTicks: RecentTick[]
  homes: WallHome[]
}

const zone: Zone = {
  zone_id: "NP3",
  zone_name: "North",
  reserve_pct_normal: 30,
  reserve_pct_stressed: 60,
  stress_threshold_mw: 1500,
  stress_margin_mw: 225,
  tick_minutes: 5,
}

const homePlan: Array<{ status: HomeStatus; count: number }> = [
  { status: "live", count: 18 },
  { status: "stale", count: 3 },
  { status: "dead", count: 2 },
  { status: "unconfirmed", count: 1 },
]

function buildHomes(): WallHome[] {
  const homes: WallHome[] = []
  for (const group of homePlan) {
    for (let index = 0; index < group.count; index += 1) {
      const number = homes.length + 1
      homes.push({
        home_id: `home-${String(number).padStart(3, "0")}`,
        status: group.status,
      })
    }
  }
  return homes
}

const homes = buildHomes()

const fleet: Tick["fleet"] = {
  live: 18,
  stale: 3,
  dead: 2,
  unconfirmed: 1,
  breaches: 0,
}

function strip(rows: Array<[string, number, number]>): RecentTick[] {
  return rows.map(([tick_id, target_mw, delivered_mw]) => ({
    tick_id,
    target_mw,
    delivered_mw,
  }))
}

const surplusTick: Tick = {
  tick_id: "tick_surplus",
  ts: "2026-07-08T19:20:00-05:00",
  source: "live",
  tape_id: null,
  mode: "AUTO",
  target: {
    mw: 0.4,
    source: "ercot",
    as_of: "2026-07-08T19:19:40-05:00",
    quality: "ok",
  },
  price: {
    usd_mwh: 42,
    source: "ercot",
    as_of: "2026-07-08T19:19:50-05:00",
    quality: "ok",
  },
  delivered_mw: 0.4,
  missed_mw: 0,
  reserve: {
    pct: 30,
    reason: "normal",
    sellable_mwh: 1.4,
    held_mwh: 0.6,
  },
  stress: {
    outage_mw: 900,
    threshold_mw: 1500,
    margin_mw: -600,
    zone_id: "NP3",
    level: "LOW",
    as_of: "2026-07-08T19:00:00-05:00",
    quality: "ok",
    calm_streak: 2,
  },
  fleet,
  quality: "ok",
  reasons: [],
  brief:
    "Delivered 0.40 of 0.40 MW. Outage capacity is under the line, so the floor stays at 30% and the sale is energy above that floor.",
  attention: null,
}

const stressTick: Tick = {
  tick_id: "tick_stress",
  ts: "2026-07-08T19:25:00-05:00",
  source: "live",
  tape_id: null,
  mode: "RESERVE",
  target: {
    mw: 0.4,
    source: "ercot",
    as_of: "2026-07-08T19:24:40-05:00",
    quality: "ok",
  },
  price: {
    usd_mwh: 185,
    source: "ercot",
    as_of: "2026-07-08T19:24:50-05:00",
    quality: "ok",
  },
  delivered_mw: 0,
  missed_mw: 0.4,
  reserve: {
    pct: 60,
    reason: "stress_high",
    sellable_mwh: 0.18,
    held_mwh: 0.42,
  },
  stress: {
    outage_mw: 2100,
    threshold_mw: 1500,
    margin_mw: 600,
    zone_id: "NP3",
    level: "HIGH",
    as_of: "2026-07-08T19:00:00-05:00",
    quality: "ok",
    calm_streak: 0,
  },
  fleet,
  quality: "ok",
  reasons: ["stress_high", "homes_dead:2"],
  brief:
    "Delivered 0 of 0.40 MW. Outage capacity is above the line, so the floor is 60% and discharge is stopped.",
  attention: null,
}

const attentionTick: Tick = {
  tick_id: "tick_attention",
  ts: "2026-07-08T19:30:00-05:00",
  source: "live",
  tape_id: null,
  mode: "RESERVE",
  target: {
    mw: 0.4,
    source: "ercot",
    as_of: "2026-07-08T19:29:40-05:00",
    quality: "ok",
  },
  price: {
    usd_mwh: 185,
    source: "ercot",
    as_of: "2026-07-08T19:29:50-05:00",
    quality: "ok",
  },
  delivered_mw: 0,
  missed_mw: 0.4,
  reserve: {
    pct: 60,
    reason: "signal_untrusted",
    sellable_mwh: 0.18,
    held_mwh: 0.42,
  },
  stress: {
    outage_mw: 2100,
    threshold_mw: 1500,
    margin_mw: 600,
    zone_id: "NP3",
    level: null,
    as_of: "2026-07-08T19:00:00-05:00",
    quality: "timeout",
    calm_streak: 0,
  },
  fleet,
  quality: "timeout",
  reasons: ["signal_untrusted"],
  brief:
    "Delivered 0 of 0.40 MW. The outage report timed out, so discharge is stopped until the feed can be trusted.",
  attention: {
    attention_id: "att_timeout",
    reason: "timeout",
    input: "stress",
    prompt: "Outage report timed out. Discharge is stopped.",
    choices: ["approve", "retry", "skip"],
    retry_spent: false,
  },
}

export const previewStates: Record<PreviewId, PreviewState> = {
  surplus: {
    label: "Surplus delivery",
    zone,
    tick: surplusTick,
    homes,
    recentTicks: strip([
      ["t1", 0.4, 0.4],
      ["t2", 0.36, 0.36],
      ["t3", 0.4, 0.4],
      ["t4", 0.42, 0.4],
      ["t5", 0.4, 0.4],
      ["t6", 0.38, 0.38],
      ["t7", 0.4, 0.4],
      ["tick_surplus", 0.4, 0.4],
    ]),
  },
  stress: {
    label: "Stress stop",
    zone,
    tick: stressTick,
    homes,
    recentTicks: strip([
      ["t1", 0.4, 0.4],
      ["t2", 0.36, 0.36],
      ["t3", 0.4, 0.4],
      ["t4", 0.4, 0.38],
      ["t5", 0.4, 0.4],
      ["t6", 0.4, 0],
      ["t7", 0.4, 0],
      ["tick_stress", 0.4, 0],
    ]),
  },
  attention: {
    label: "Attention choice",
    zone,
    tick: attentionTick,
    homes,
    recentTicks: strip([
      ["t1", 0.4, 0.4],
      ["t2", 0.4, 0.4],
      ["t3", 0.36, 0.36],
      ["t4", 0.4, 0],
      ["t5", 0.4, 0],
      ["t6", 0.4, 0],
      ["t7", 0.4, 0],
      ["tick_attention", 0.4, 0],
    ]),
  },
}
