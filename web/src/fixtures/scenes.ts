import type { TickView } from "../contracts"

/** Local wall scenes. They are not engine ticks and do not change the 12-tick tape. */

export type SceneId = "devices" | "failsafe"

export type SceneQuality = "ok" | "timeout" | "stale"

export type Scene = {
  id: SceneId
  label: string
  quality: SceneQuality
  tick: TickView
}

export const scenes: Scene[] = [
  {
    id: "devices",
    label: "15% dead",
    quality: "ok",
    tick: {
      tick: 0,
      ts: "2024-07-08T14:22:00-05:00",
      mode: "AUTO",
      target_mw: 0.4,
      target_label: "synthetic",
      delivered_mw: 0.34,
      missed_mw: 0.06,
      price_usd_mwh: 48,
      price_label: "synthetic",
      reserve_pct: 30,
      policy_reason: "normal",
      risk_level: "LOW",
      houston_mw: 3427,
      north_mw: 9429,
      south_mw: 4864,
      west_mw: 4474,
      live_homes: 81,
      stale_homes: 4,
      dead_homes: 15,
      breaches: 0,
      reasons: ["homes_dead:15", "homes_stale:4", "fleet_headroom_short"],
      brief:
        "Delivered 0.34 of 0.40 MW (synthetic target). 15 homes are dead and 4 are stale, so they got no work. The live homes kept the rest. Floor held at 30%.",
    },
  },
  {
    id: "failsafe",
    label: "Fail-safe",
    quality: "timeout",
    tick: {
      tick: 0,
      ts: "2024-07-08T14:23:00-05:00",
      mode: "AUTO",
      target_mw: 0.4,
      target_label: "synthetic",
      delivered_mw: 0,
      missed_mw: 0.4,
      price_usd_mwh: 185,
      price_label: "synthetic",
      reserve_pct: 60,
      policy_reason: "signal_unavailable",
      risk_level: null,
      houston_mw: 3427,
      north_mw: 9429,
      south_mw: 4864,
      west_mw: 4474,
      live_homes: 100,
      stale_homes: 0,
      dead_homes: 0,
      breaches: 0,
      reasons: ["signal_unavailable"],
      brief:
        "Delivered 0.00 of 0.40 MW (synthetic target). The outage report timed out. Risk is unknown, so the floor is 60% and discharge is stopped.",
    },
  },
]

const failsafe = scenes[1]
if (failsafe !== undefined) {
  Object.assign(failsafe.tick, { stress_quality: "timeout" })
}
