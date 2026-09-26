import type { Playback, Tape, Tick } from "./types"

export const previewTape: Tape = {
  tape_id: "demo-stress",
  title: "Outage report goes bad, then two calm readings",
  ticks: 12,
  labeled: "synthetic",
}

export const previewTapes: Tape[] = [previewTape]

export const playbackRunning: Playback = {
  tape_id: "demo-stress",
  tick_index: 4,
  tick_count: 12,
}

export const playbackOff: Playback | null = null

export const liveTick: Tick = {
  tick_id: "tick_01H",
  ts: "2026-07-08T19:20:00-05:00",
  source: "live",
  tape_id: null,
  mode: "RESERVE",
  target: {
    mw: 0.4,
    source: "ercot",
    as_of: "2026-07-08T19:19:40-05:00",
    quality: "ok",
  },
  price: {
    usd_mwh: 185,
    source: "ercot",
    as_of: "2026-07-08T19:19:50-05:00",
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
  fleet: {
    live: 70,
    stale: 10,
    dead: 18,
    unconfirmed: 2,
    breaches: 0,
  },
  quality: "ok",
  reasons: ["stress_high"],
  brief:
    "Delivered 0 of 0.40 MW. Outage capacity is above the line, so the floor is 60% and discharge is stopped.",
  attention: null,
}

export const playbackTick: Tick = {
  tick_id: "tick_tape_04",
  ts: "2026-07-08T19:25:00-05:00",
  source: "playback",
  tape_id: "demo-stress",
  mode: "AUTO",
  target: {
    mw: 0.4,
    source: "tape:demo-stress",
    as_of: "2026-07-08T19:24:40-05:00",
    quality: "ok",
  },
  price: {
    usd_mwh: 42,
    source: "tape:demo-stress",
    as_of: "2026-07-08T19:24:50-05:00",
    quality: "ok",
  },
  delivered_mw: 0.4,
  missed_mw: 0,
  reserve: {
    pct: 30,
    reason: "normal",
    sellable_mwh: 0.6,
    held_mwh: 0.26,
  },
  stress: {
    outage_mw: 900,
    threshold_mw: 1500,
    margin_mw: -600,
    zone_id: "NP3",
    level: "LOW",
    as_of: "2026-07-08T19:00:00-05:00",
    quality: "ok",
    calm_streak: 1,
  },
  fleet: {
    live: 70,
    stale: 10,
    dead: 18,
    unconfirmed: 2,
    breaches: 0,
  },
  quality: "ok",
  reasons: ["fleet_headroom_short"],
  brief: "Tape demo-stress, tick 4. Delivered 0.40 of 0.40 MW on the synthetic tape.",
  attention: null,
}

export const previewTicks: Tick[] = [liveTick, playbackTick]
