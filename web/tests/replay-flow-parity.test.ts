import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { FlowRequest } from "../src/features/flow/api"
import type {
  ActiveAlert, FlowCounty, FlowTick, JevReading, Provenance, ScenarioList, SessionState, StartSummary,
} from "../src/features/flow/types"
import { AboutDataDrawer } from "../src/features/replay/AboutDataDrawer"
import { AlertDetail } from "../src/features/replay/AlertDetail"
import { ScenarioRail } from "../src/features/replay/ScenarioRail"
import { SessionLog } from "../src/features/replay/SessionLog"
import { StartCharge } from "../src/features/replay/StartCharge"
import { ZoneShares } from "../src/features/replay/ZoneShares"

/*
 * Real engine data. Ticks, alerts and the county roster below were copied from an in-process run of
 * server.engine.scenario.Session at the post-#47 head (HOME_MAX_KW=11.4, HOME_KWH=25, seed 42):
 * - berylTick22: beryl-landfall, Beryl alert sent after tick 1, tick 22 (Harris JEV yes 0.74).
 * - heatherTick2: heather, both freeze alerts sent after tick 1, tick 2 (every county JEV no).
 * - holdTick: operator-hold tick 4. dischargeTick: storm-rule-high tick 4.
 * - expiredTick: storm-rule-night, Midland alert sent after tick 1, tick 20 (first tick after expiry).
 * Only the FlowTick fields are kept.
 */

const QUESTION = "Does this alert threaten power delivery to homes in this county in the next 6 hours?"

function reading(fields: Omit<JevReading, "question" | "model" | "recorded"> & { alert_id: string }): JevReading {
  return { question: QUESTION, model: "jev-1.13.0", recorded: true, ...fields }
}

const counties: FlowCounty[] = [
  { zone: "Houston", fips: "48201", name: "Harris" },
  { zone: "Houston", fips: "48157", name: "Fort Bend" },
  { zone: "Houston", fips: "48039", name: "Brazoria" },
  { zone: "Houston", fips: "48167", name: "Galveston" },
  { zone: "Houston", fips: "48339", name: "Montgomery" },
  { zone: "North", fips: "48113", name: "Dallas" },
  { zone: "North", fips: "48439", name: "Tarrant" },
  { zone: "North", fips: "48085", name: "Collin" },
  { zone: "North", fips: "48121", name: "Denton" },
  { zone: "West", fips: "48329", name: "Midland" },
  { zone: "West", fips: "48135", name: "Ector" },
  { zone: "West", fips: "48451", name: "Tom Green" },
  { zone: "West", fips: "48441", name: "Taylor" },
  { zone: "South", fips: "48355", name: "Nueces" },
  { zone: "South", fips: "48029", name: "Bexar" },
  { zone: "South", fips: "48453", name: "Travis" },
  { zone: "South", fips: "48215", name: "Hidalgo" },
]

const berylHarris = reading({
  answer: "yes", probability: 0.74, called_at: "2026-09-27T00:54:29+00:00", latency_ms: 288,
  input_label: "archived NWS alert 202407080859-KHGX-WTUS84-TCVHGX, county 48201 (Houston zone)",
  alert_id: "beryl-harris-tropical-storm-warning",
})

const berylAlert: ActiveAlert = {
  id: "beryl-harris-tropical-storm-warning",
  event: "Tropical Storm Warning",
  headline: "TROPICAL STORM WARNING REMAINS IN EFFECT",
  areaDesc: "Inland Harris",
  onset: "2024-07-06T21:52:00-05:00",
  expires: "2024-07-08T16:05:00-05:00",
  sent: "2024-07-08T03:59:00-05:00",
  sender: "National Weather Service Houston/Galveston TX",
  source_url: "https://mesonet.agron.iastate.edu/p.php?pid=202407080859-KHGX-WTUS84-TCVHGX",
  source_label: "Iowa Environmental Mesonet NWS archive",
  counties: ["048201"],
  zones: ["Houston"],
  sent_at_tick: 2,
  jev: berylHarris,
  jev_by_county: { "48201": { county_name: "Harris", zone: "Houston", reading: berylHarris, decision: "raise" } },
}

const DALLAS_ID = "heather-dallas-hard-freeze-warning"
const dallasAnchor = reading({
  answer: "no", probability: 0.12, called_at: "2026-09-27T00:54:29+00:00", latency_ms: 206,
  input_label: "archived NWS alert 202401151205-KFWD-WWUS74-NPWFWD, county 48113 (North zone)", alert_id: DALLAS_ID,
})

const dallasFreeze: ActiveAlert = {
  id: DALLAS_ID,
  event: "Hard Freeze Warning",
  headline: "HARD FREEZE WARNING REMAINS IN EFFECT UNTIL 10 AM CST THIS MORNING",
  areaDesc: "Montague; Cooke; Grayson; Fannin; Lamar; Young; Jack; Wise; Denton; Collin; Stephens; Palo Pinto; Parker; Tarrant; Dallas; Rockwall; Eastland",
  onset: "2024-01-15T00:00:00-06:00",
  expires: "2024-01-15T10:00:00-06:00",
  sent: "2024-01-15T06:05:00-06:00",
  sender: "National Weather Service Fort Worth TX",
  source_url: "https://mesonet.agron.iastate.edu/p.php?pid=202401151205-KFWD-WWUS74-NPWFWD",
  source_label: "Iowa Environmental Mesonet NWS archive",
  counties: ["048337", "048097", "048181", "048147", "048277", "048503", "048237", "048497", "048121", "048085", "048429", "048363", "048367", "048439", "048113", "048397", "048133"],
  zones: ["North"],
  sent_at_tick: 2,
  jev: dallasAnchor,
  jev_by_county: {
    "48113": { county_name: "Dallas", zone: "North", reading: dallasAnchor, decision: "keep_base" },
    "48439": { county_name: "Tarrant", zone: "North", decision: "keep_base", reading: reading({
      answer: "no", probability: 0.14, called_at: "2026-09-27T04:50:24+00:00", latency_ms: 355, county_fips: "48439",
      input_label: "archived NWS alert 202401151205-KFWD-WWUS74-NPWFWD, county 48439 (Tarrant, North zone)", alert_id: DALLAS_ID }) },
    "48085": { county_name: "Collin", zone: "North", decision: "keep_base", reading: reading({
      answer: "no", probability: 0.14, called_at: "2026-09-27T04:50:24+00:00", latency_ms: 287, county_fips: "48085",
      input_label: "archived NWS alert 202401151205-KFWD-WWUS74-NPWFWD, county 48085 (Collin, North zone)", alert_id: DALLAS_ID }) },
    "48121": { county_name: "Denton", zone: "North", decision: "keep_base", reading: reading({
      answer: "no", probability: 0.15, called_at: "2026-09-27T04:50:25+00:00", latency_ms: 217, county_fips: "48121",
      input_label: "archived NWS alert 202401151205-KFWD-WWUS74-NPWFWD, county 48121 (Denton, North zone)", alert_id: DALLAS_ID }) },
  },
}

const HARRIS_ID = "heather-harris-hard-freeze-warning"
const HGX = "archived NWS alert 202401151918-KHGX-WWUS74-NPWHGX"
const harrisAnchor = reading({
  answer: "no", probability: 0.07, called_at: "2026-09-27T00:54:29+00:00", latency_ms: 247,
  input_label: `${HGX}, county 48201 (Houston zone)`, alert_id: HARRIS_ID,
})

const harrisFreeze: ActiveAlert = {
  id: HARRIS_ID,
  event: "Hard Freeze Warning",
  headline: "HARD FREEZE WARNING NOW IN EFFECT UNTIL 9 AM CST WEDNESDAY",
  areaDesc: "Houston; Trinity; Madison; Walker; San Jacinto; Polk; Burleson; Brazos; Washington; Grimes; Montgomery; Northern Liberty; Colorado; Austin; Waller; Inland Harris; Chambers; Wharton; Fort Bend; Inland Jackson; Inland Matagorda; Inland Brazoria; Inland Galveston; Southern Liberty; Coastal Harris",
  onset: "2024-01-15T13:18:00-06:00",
  expires: "2024-01-17T10:00:00-06:00",
  sent: "2024-01-15T13:18:00-06:00",
  sender: "National Weather Service Houston/Galveston TX",
  source_url: "https://mesonet.agron.iastate.edu/p.php?pid=202401151918-KHGX-WWUS74-NPWHGX",
  source_label: "Iowa Environmental Mesonet NWS archive",
  counties: ["048225", "048455", "048313", "048471", "048407", "048373", "048051", "048041", "048477", "048185", "048339", "048291", "048089", "048015", "048473", "048201", "048071", "048481", "048157", "048239", "048321", "048039", "048167"],
  zones: ["Houston"],
  sent_at_tick: 2,
  jev: harrisAnchor,
  jev_by_county: {
    "48201": { county_name: "Harris", zone: "Houston", reading: harrisAnchor, decision: "keep_base" },
    "48157": { county_name: "Fort Bend", zone: "Houston", decision: "keep_base", reading: reading({
      answer: "no", probability: 0.06, called_at: "2026-09-27T04:50:23+00:00", latency_ms: 314, county_fips: "48157",
      input_label: `${HGX}, county 48157 (Fort Bend, Houston zone)`, alert_id: HARRIS_ID }) },
    "48039": { county_name: "Brazoria", zone: "Houston", decision: "keep_base", reading: reading({
      answer: "no", probability: 0.07, called_at: "2026-09-27T04:50:23+00:00", latency_ms: 248, county_fips: "48039",
      input_label: `${HGX}, county 48039 (Brazoria, Houston zone)`, alert_id: HARRIS_ID }) },
    "48167": { county_name: "Galveston", zone: "Houston", decision: "keep_base", reading: reading({
      answer: "no", probability: 0.07, called_at: "2026-09-27T04:50:23+00:00", latency_ms: 196, county_fips: "48167",
      input_label: `${HGX}, county 48167 (Galveston, Houston zone)`, alert_id: HARRIS_ID }) },
    "48339": { county_name: "Montgomery", zone: "Houston", decision: "keep_base", reading: reading({
      answer: "no", probability: 0.07, called_at: "2026-09-27T04:50:23+00:00", latency_ms: 327, county_fips: "48339",
      input_label: `${HGX}, county 48339 (Montgomery, Houston zone)`, alert_id: HARRIS_ID }) },
  },
}

const MIDLAND_ID = "tuning2026-midland-flash-flood-warning"
const midlandAnchor = reading({
  answer: "no", probability: 0.24, called_at: "2026-09-27T00:55:51+00:00", latency_ms: 248,
  input_label: "archived NWS alert 202609221931-KMAF-WGUS54-FFWMAF, county 48329 (West zone)", alert_id: MIDLAND_ID,
})

const midlandFlood: ActiveAlert = {
  id: MIDLAND_ID,
  event: "Flash Flood Warning",
  headline: "Flash Flood Warning, National Weather Service Midland/Odessa TX, 231 PM CDT Tue Sep 22 2026",
  areaDesc: "Ector; Midland",
  onset: "2026-09-22T14:31:00-05:00",
  expires: "2026-09-22T17:30:00-05:00",
  counties: ["048135", "048329"],
  zones: ["West"],
  sent_at_tick: 2,
  jev: midlandAnchor,
  jev_by_county: {
    "48329": { county_name: "Midland", zone: "West", reading: midlandAnchor, decision: "keep_base" },
    "48135": { county_name: "Ector", zone: "West", decision: "keep_base", reading: reading({
      answer: "no", probability: 0.19, called_at: "2026-09-27T04:50:25+00:00", latency_ms: 290, county_fips: "48135",
      input_label: "archived NWS alert 202609221931-KMAF-WGUS54-FFWMAF, county 48135 (Ector, West zone)", alert_id: MIDLAND_ID }) },
  },
}

const berylTick22: FlowTick = {
  tick: 22,
  ts: "2024-07-07T23:45:00-05:00",
  mode: "AUTO",
  target_mw: 0.02,
  target_label: "synthetic:price-shaped",
  delivered_mw: 0.02,
  missed_mw: 0.0,
  price_usd_mwh: 13.9,
  price_label: "recorded:ERCOT NP6-905-CD LZ_HOUSTON",
  reserve_pct: 30.0,
  policy_reason: "normal",
  risk_level: "LOW",
  intent: "charge",
  intent_reason: "grid_call_served",
  reasons: ["charging", "homes_stale:1"],
  breaches: 0,
  zone_reserve_pct: { Houston: 60.0, North: 30.0, South: 30.0, West: 30.0 },
  zone_reasons: { Houston: "weather_alert", North: "normal", South: "normal", West: "normal" },
  county_reserve_pct: { "48201": 60.0, "48157": 30.0, "48039": 30.0, "48167": 30.0, "48339": 30.0 },
  county_reasons: {
    "48201": "weather_alert_jev_yes", "48157": "not_in_alert", "48039": "not_in_alert", "48167": "not_in_alert", "48339": "not_in_alert",
  },
  brief: "Delivered 0.02 of 0.02 MW. Floor 30% (Houston 60%: weather_alert); charging on cheap power; 1 home is stale.",
  charging_mw: 0.24676088100000002,
  grid_down_zones: [],
}

const heatherTick2: FlowTick = {
  tick: 2,
  ts: "2024-01-15T07:05:00-06:00",
  mode: "AUTO",
  target_mw: 0.2,
  target_label: "synthetic",
  delivered_mw: 0.2,
  missed_mw: 0.0,
  price_usd_mwh: 151.69,
  price_label: "recorded:ERCOT NP6-905-CD LZ_HOUSTON",
  reserve_pct: 30.0,
  policy_reason: "normal",
  risk_level: "LOW",
  intent: "discharge",
  intent_reason: "",
  reasons: ["reserve_refill", "homes_stale:2"],
  breaches: 0,
  zone_reserve_pct: { Houston: 30.0, North: 30.0, South: 30.0, West: 30.0 },
  zone_reasons: { Houston: "normal", North: "normal", South: "normal", West: "normal" },
  county_reserve_pct: {
    "48201": 30.0, "48157": 30.0, "48039": 30.0, "48167": 30.0, "48339": 30.0, "48113": 30.0, "48439": 30.0, "48085": 30.0, "48121": 30.0,
  },
  county_reasons: {
    "48201": "jev_no", "48157": "jev_no", "48039": "jev_no", "48167": "jev_no", "48339": "jev_no",
    "48113": "jev_no", "48439": "jev_no", "48085": "jev_no", "48121": "jev_no",
  },
  brief: "Delivered 0.20 of 0.20 MW. Refilling batteries under their reserve floor; 2 homes are stale.",
  charging_mw: 0.19184399800000002,
  grid_down_zones: [],
}

const holdTick: FlowTick = {
  tick: 4,
  ts: "2026-09-17T16:45:00-05:00",
  mode: "HOLD",
  target_mw: 0.5477,
  target_label: "synthetic:price-shaped",
  delivered_mw: 0.0,
  missed_mw: 0.5477,
  price_usd_mwh: 251.24,
  price_label: "recorded:ERCOT NP6-905-CD LZ_NORTH",
  reserve_pct: 30.0,
  policy_reason: "normal",
  risk_level: "LOW",
  intent: "hold",
  intent_reason: "operator_hold",
  reasons: ["operator_hold"],
  breaches: 0,
  zone_reserve_pct: { Houston: 30.0, North: 30.0, South: 30.0, West: 30.0 },
  zone_reasons: { Houston: "normal", North: "normal", South: "normal", West: "normal" },
  county_reserve_pct: {},
  county_reasons: {},
  brief: "Delivered 0.00 of 0.55 MW. Operator hold.",
  charging_mw: 0.0,
  grid_down_zones: [],
}

const dischargeTick: FlowTick = {
  tick: 4,
  ts: "2026-09-16T02:15:00-05:00",
  mode: "AUTO",
  target_mw: 0.1648,
  target_label: "synthetic:price-shaped",
  delivered_mw: 0.1648,
  missed_mw: 0.0,
  price_usd_mwh: 53.16,
  price_label: "recorded:ERCOT NP6-905-CD LZ_NORTH",
  reserve_pct: 30.0,
  policy_reason: "normal",
  risk_level: "LOW",
  intent: "discharge",
  intent_reason: "grid_call",
  reasons: ["reserve_refill", "homes_stale:1", "timed_out:1", "duplicates_ignored:1", "over_delivery:1"],
  breaches: 0,
  zone_reserve_pct: { Houston: 30.0, North: 30.0, South: 30.0, West: 30.0 },
  zone_reasons: { Houston: "normal", North: "normal", South: "normal", West: "normal" },
  county_reserve_pct: {},
  county_reasons: {},
  brief: "Delivered 0.16 of 0.16 MW. Refilling batteries under their reserve floor; 1 home is stale; timed out 1; duplicates ignored 1; over delivery 1.",
  charging_mw: 0.104435993,
  grid_down_zones: [],
}

const expiredTick: FlowTick = {
  tick: 20,
  ts: "2026-09-22T17:35:00-05:00",
  mode: "AUTO",
  target_mw: 0.2088,
  target_label: "synthetic:price-shaped",
  delivered_mw: 0.20879999999999999,
  missed_mw: 2.7755575615628914e-17,
  price_usd_mwh: 64.85,
  price_label: "recorded:ERCOT NP6-905-CD LZ_NORTH",
  reserve_pct: 30.0,
  policy_reason: "normal",
  risk_level: "LOW",
  intent: "discharge",
  intent_reason: "",
  reasons: ["homes_stale:1", "timed_out:1", "duplicates_ignored:1", "over_delivery:1"],
  breaches: 0,
  zone_reserve_pct: { Houston: 30.0, North: 30.0, South: 30.0, West: 30.0 },
  zone_reasons: { Houston: "normal", North: "normal", South: "normal", West: "normal" },
  county_reserve_pct: {},
  county_reasons: {},
  brief: "Delivered 0.21 of 0.21 MW. 1 home is stale; timed out 1; duplicates ignored 1; over delivery 1.",
  charging_mw: 0.0,
  grid_down_zones: [],
}

/** The seed-42 fleet the worker reported (25 kWh / 11.4 kW packs, base floor 30%). */
const realStart: StartSummary = {
  seed: 42,
  range_pct: [10.0, 95.0],
  histogram: [0, 15, 13, 12, 10, 10, 15, 8, 10, 7],
  min_pct: 10.6,
  max_pct: 94.8,
  mean_pct: 50.8,
  below_base_floor: { North: 7, West: 7, South: 9, Houston: 5 },
  base_floor_pct: 30.0,
  homes: 100,
  pack: { kwh: 25.0, kw: 11.4 },
}

const start: StartSummary = {
  seed: 4242,
  range_pct: [5, 95],
  histogram: [3, 5, 8, 10, 12, 9, 7, 4, 1, 1],
  min_pct: 6.2,
  max_pct: 94.1,
  mean_pct: 48.3,
  below_base_floor: { North: 4, West: 2 },
  base_floor_pct: 20,
  homes: 60,
  pack: { kwh: 13.5, kw: 5 },
}

const provenance: Provenance = {
  tick: 3,
  ts: "2024-07-08T04:10:00-05:00",
  posting: { report: "NP3-233-CD", table: "public.ercot_postings", file: "tapes/risk/beryl-03.json", posted_at: "2024-07-08T04:00:47", rows: 168 },
  rating: { level: "HIGH", peak_mw: 81234, peak_hour: 17, trigger_mw: 79000.4, baseline_mw: 68696, margin_mw: 2234, driving_zone: "Houston" },
  price: { usd_mwh: 31.5, label: "LZ_HOUSTON real-time" },
  zone_prices: { label: "ERCOT real-time settlement point prices", zones: { West: 20, North: 25, South: 30, Houston: 31.5 } },
  target: { mw: 0.4, label: "practice ask" },
  baseline: { file: "tapes/baseline/beryl.json", postings: 720, from: "2024-06-01", to: "2024-06-30" },
  events: {},
  archive_rows: {
    posting: { id: 8822, report: "NP3-233-CD", posted_at: "2024-07-08T04:00:47", file_name: "np3-233.csv" },
    prices: [{ settlement_point: "LZ_HOUSTON", interval_ending: "2024-07-08T04:15:00-05:00", price_usd_mwh: 31.5 }],
    overlay: "Houston feed dropped by hand",
  },
}

/** Scenario entries as Session.state() sends them (tapes/scenarios/catalog.json). */
const berylScenario: SessionState["scenario"] = {
  id: "beryl-landfall",
  name: "Hurricane Beryl landfall",
  event: "beryl",
  window: "2024-07-07 22:00 to 2024-07-08 14:00 CT",
  summary: "Beryl came ashore early on July 8. Houston load fell away and LZ_HOUSTON went negative from about 08:00 to 13:30. Prices stay under $25 all window, so the fleet charges to full; the storm rule never read HIGH. The operator can mark a zone's grid down (overlay) to show batteries carrying homes.",
  label: "recorded ERCOT; target synthetic:price-shaped",
  tape: "tapes/scenarios/beryl-landfall.json",
  baseline: "data/fixtures/beryl/baseline.json",
  grid_down_overlay: true,
  alerts: [{ id: berylAlert.id, event: berylAlert.event, areaDesc: berylAlert.areaDesc, zones: ["Houston"] }],
}

const heatherScenario: SessionState["scenario"] = {
  id: "heather",
  name: "Winter Storm Heather",
  event: "heather",
  window: "2024-01-15 07:00 to 19:00 CT",
  summary: "Recorded NP3-233-CD outage postings and four-zone NP6-905-CD prices. The storm rule reads HIGH only after the 13:03 posting.",
  label: "recorded ERCOT; target synthetic",
  tape: "tapes/heather.json",
  baseline: "data/fixtures/heather/baseline.json",
  grid_down_overlay: false,
  alerts: [
    { id: DALLAS_ID, event: dallasFreeze.event, areaDesc: dallasFreeze.areaDesc, zones: ["North"] },
    { id: HARRIS_ID, event: harrisFreeze.event, areaDesc: harrisFreeze.areaDesc, zones: ["Houston"] },
  ],
}

function session(overrides: Partial<SessionState> = {}): SessionState {
  return {
    status: "paused",
    error: null,
    updated_at: "2026-09-26T10:00:00Z",
    scenario: berylScenario,
    seed: 42,
    speed: 60,
    speeds: [15, 60, 300],
    step_seconds: 5,
    tick_minutes: 5,
    tick_index: 22,
    tick_count: 193,
    start,
    tick: berylTick22,
    homes: [],
    zones: {
      West: { selling_mw: 0.05, charging_mw: 0, reserve_pct: 20, reason: "normal", price_usd_mwh: 20, grid_down: false, homes: 15, states: {}, soc_mwh: 0.1 },
      North: { selling_mw: 0.15, charging_mw: 0.02, reserve_pct: 20, reason: "normal", price_usd_mwh: 25, grid_down: false, homes: 15, states: {}, soc_mwh: 0.1 },
      South: { selling_mw: 0.05, charging_mw: 0, reserve_pct: 20, reason: "normal", price_usd_mwh: 30, grid_down: false, homes: 15, states: {}, soc_mwh: 0.1 },
    },
    charging_mw: 0.02,
    provenance,
    alerts: [berylAlert],
    counties,
    grid_down_zones: ["Houston"],
    history: [],
    totals: null,
    log: [
      { at: "2026-09-26T09:59:00Z", text: "started Beryl landfall" },
      { at: "2026-09-26T09:59:01Z", text: "fleet seeded (seed 4242)" },
      { at: "2026-09-26T10:00:00Z", text: "refused alert: alert already sent" },
    ],
    honest_limits: ["Prices are archive rows."],
    ...overrides,
  }
}

const scenarios: ScenarioList = {
  scenarios: [
    { id: "beryl-landfall", name: "Hurricane Beryl landfall", alerts: [], grid_down_overlay: true },
    { id: "calm-charge", name: "Calm day: charge at noon, sell at the peak", alerts: [] },
  ],
  speeds: [15, 60, 300],
  default_speed: 60,
}

function drawer(state: SessionState): string {
  return renderToStaticMarkup(createElement(AboutDataDrawer, { state, onClose: () => {} }))
}

function alertBox(alert: ActiveAlert, tick: FlowTick | null, roster: FlowCounty[] = counties): string {
  return renderToStaticMarkup(createElement(AlertDetail, { alert, counties: roster, tick }))
}

/** The text of each county row in the JEV table, cells joined with " | ". */
function countyRows(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, "text/html")
  return [...doc.querySelectorAll(".replay-county-table tbody tr")].map((row) =>
    [...row.querySelectorAll("th, td")].map((cell) => cell.textContent?.trim()).join(" | "))
}

/** The dt/dd pairs of the drawer, "key: value", in order. */
function dataRows(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, "text/html")
  return [...doc.querySelectorAll(".replay-data-row")].map((row) =>
    `${row.querySelector("dt")?.textContent}: ${row.querySelector("dd")?.textContent}`)
}

describe("About this data: scenario section (gap 2)", () => {
  it("shows the scenario window, label, tape, baseline and summary", () => {
    const html = drawer(session())
    expect(html).toContain("Scenario")
    expect(html).toContain("2024-07-07 22:00 to 2024-07-08 14:00 CT")
    expect(html).toContain("recorded ERCOT; target synthetic:price-shaped")
    expect(html).toContain("tapes/scenarios/beryl-landfall.json")
    expect(html).toContain("data/fixtures/beryl/baseline.json")
    expect(html).toContain("Beryl came ashore early on July 8.")
  })

  it("says not reported for missing scenario fields instead of inventing them", () => {
    const html = drawer(session({ scenario: { ...berylScenario!, window: undefined, label: undefined, tape: undefined } }))
    expect(html).toMatch(/Window<\/dt><dd>Not reported/)
    expect(html).toMatch(/Label<\/dt><dd>Not reported/)
    expect(html).toMatch(/Tape<\/dt><dd>Not reported/)
  })
})

describe("Alert detail (gaps 10 and 11)", () => {
  it("shows area, NWS county codes, mapped zone, onset, sent tick and the source link", () => {
    const html = alertBox(berylAlert, berylTick22)
    expect(html).toContain("Inland Harris")
    expect(html).toMatch(/County codes \(NWS SAME\)<\/dt><dd>048201</)
    expect(html).not.toContain("Counties (FIPS)")
    expect(html).toMatch(/Mapped to zone<\/dt><dd>Houston/)
    expect(html).toContain("Jul 6, 2024 21:52 CDT")
    expect(html).toMatch(/Sent at tick<\/dt><dd>2/)
    expect(html).toContain('href="https://mesonet.agron.iastate.edu/p.php?pid=202407080859-KHGX-WTUS84-TCVHGX"')
    expect(html).toContain("Iowa Environmental Mesonet NWS archive")
  })

  it("shows the anchor county's full JEV reading, with P(yes) and a UTC call time", () => {
    const html = alertBox(berylAlert, berylTick22)
    expect(html).toContain("JEV reading · county floor gate")
    expect(html).toContain("Anchor county: Harris (48201)")
    expect(html).toContain(QUESTION)
    expect(html).toContain("jev-1.13.0 · 288 ms")
    expect(html).toMatch(/Called<\/dt><dd>Sep 27 00:54:29 UTC/)
    expect(html).toContain("county 48201 (Houston zone)")
    expect(html).toContain("P(yes)")
    expect(html).not.toContain("P(threat)")
  })

  it("says JEV gates each county's alert floor and that rules still compute every order (Beryl: Harris yes 0.74 raised to 60%)", () => {
    const html = alertBox(berylAlert, berylTick22)
    // The pre-#47 sentence is false at this head: JEV now sets each named county's alert floor.
    expect(html).not.toContain("never dispatches")
    expect(html).not.toContain("Rules decide the floor")
    expect(html).toContain("JEV gates each county&#x27;s alert floor: P(yes) of 0.5 or more raises the county to the storm reserve, below 0.5 keeps the base floor, and no reading keeps the storm reserve (fail safe).")
    expect(html).toContain("ERCOT HIGH or an unreadable outage report still raises every county.")
    expect(html).toContain("Rules still compute every order; JEV only gates these floors.")
    expect(countyRows(html)).toEqual(["Harris (48201) | 0.74 | yes: storm reserve | 60% · NWS alert, JEV yes"])
  })

  it("lists every county the Harris freeze alert names, each JEV no at the base floor", () => {
    const html = alertBox(harrisFreeze, heatherTick2)
    expect(countyRows(html)).toEqual([
      "Harris (48201) | 0.07 | no: base floor | 30% · NWS alert, JEV no (base floor)",
      "Fort Bend (48157) | 0.06 | no: base floor | 30% · NWS alert, JEV no (base floor)",
      "Brazoria (48039) | 0.07 | no: base floor | 30% · NWS alert, JEV no (base floor)",
      "Galveston (48167) | 0.07 | no: base floor | 30% · NWS alert, JEV no (base floor)",
      "Montgomery (48339) | 0.07 | no: base floor | 30% · NWS alert, JEV no (base floor)",
    ])
  })

  it("shows the Dallas freeze alert's four North counties as recorded: all JEV no, Collin included", () => {
    const html = alertBox(dallasFreeze, heatherTick2)
    expect(html).toContain("Anchor county: Dallas (48113)")
    expect(countyRows(html)).toEqual([
      "Dallas (48113) | 0.12 | no: base floor | 30% · NWS alert, JEV no (base floor)",
      "Tarrant (48439) | 0.14 | no: base floor | 30% · NWS alert, JEV no (base floor)",
      "Collin (48085) | 0.14 | no: base floor | 30% · NWS alert, JEV no (base floor)",
      "Denton (48121) | 0.15 | no: base floor | 30% · NWS alert, JEV no (base floor)",
    ])
  })

  it("says the alert is not in force once the tick carries no county floor for it, and gives the zone floor", () => {
    const html = alertBox(midlandFlood, expiredTick)
    expect(countyRows(html)).toEqual([
      "Midland (48329) | 0.24 | no: base floor | Alert not in force this tick · zone floor 30%",
      "Ector (48135) | 0.19 | no: base floor | Alert not in force this tick · zone floor 30%",
    ])
  })

  it("says no tick yet for the floor before the first tick", () => {
    const html = alertBox(berylAlert, null)
    expect(countyRows(html)).toEqual(["Harris (48201) | 0.74 | yes: storm reserve | No tick played yet"])
  })

  it("does not claim no reading when the alert has no anchor county but other counties have readings", () => {
    const noAnchor: ActiveAlert = { ...harrisFreeze, jev: null }
    const html = alertBox(noAnchor, heatherTick2)
    expect(html).not.toContain("No recorded JEV reading")
    expect(countyRows(html)).toHaveLength(5)
    expect(html).toContain("Details shown for Harris (48201)")
    expect(html).not.toContain("Anchor county:")
  })

  it("says no recorded reading only when every county lacks one, and the fail-safe decision", () => {
    const bare: ActiveAlert = {
      ...berylAlert, jev: null,
      jev_by_county: { "48201": { county_name: "Harris", zone: "Houston", reading: null, decision: "raise_no_reading" } },
    }
    const html = alertBox(bare, null)
    expect(html).toContain("No recorded JEV reading for this alert.")
    expect(countyRows(html)).toEqual(["Harris (48201) | no reading | no reading: storm reserve (fail safe) | No tick played yet"])
  })

  it("marks missing alert fields as not reported and has no link without a source", () => {
    const bare: ActiveAlert = { id: "x", zones: [], sent_at_tick: null, jev: null }
    const html = alertBox(bare, null)
    expect(html).toMatch(/Area<\/dt><dd>Not reported/)
    expect(html).toMatch(/County codes \(NWS SAME\)<\/dt><dd>Not reported/)
    expect(html).toMatch(/Mapped to zone<\/dt><dd>Not reported/)
    expect(html).toMatch(/Source<\/dt><dd>Not reported/)
    expect(html).toContain("After the last tick")
    expect(html).not.toContain("<a ")
    expect(html).toContain("No recorded JEV reading")
  })

  it("is what the drawer shows for each sent alert, with the session's counties and tick", () => {
    const html = drawer(session())
    expect(html).toContain("jev-1.13.0 · 288 ms")
    expect(html).toContain("048201")
    expect(countyRows(html)).toEqual(["Harris (48201) | 0.74 | yes: storm reserve | 60% · NWS alert, JEV yes"])
    const heather = drawer(session({ scenario: heatherScenario, tick: heatherTick2, alerts: [dallasFreeze, harrisFreeze] }))
    expect(countyRows(heather)).toHaveLength(9)
    expect(heather).not.toContain("never dispatches")
  })
})

describe("About this data: provenance rows (gap 13)", () => {
  it("shows the posting table, rows, Supabase id, rule reading, price rows, grid ask and baseline range", () => {
    const html = drawer(session())
    expect(html).toContain("public.ercot_postings")
    expect(html).toMatch(/Rows<\/dt><dd>168/)
    expect(html).toContain("ercot_postings.id 8822 · np3-233.csv")
    expect(html).toContain("HIGH: peak 81,234 MW at HE17 vs trigger 79,000 MW (typical 68,696 MW)")
    expect(html).toContain("ERCOT real-time settlement point prices")
    expect(html).toContain("LZ_HOUSTON 2024-07-08T04:15:00-05:00")
    expect(html).toContain("0.400 MW · practice ask")
    expect(html).toContain("720 postings, 2024-06-01 to 2024-06-30")
  })

  it("says the outage report is missing and the engine fails safe when no posting is on the tick", () => {
    const html = drawer(session({ provenance: { ...provenance, posting: null, rating: null, archive_rows: null, baseline: { file: "b.json" } } }))
    expect(html).toContain("None on this tick: risk unknown, fail safe")
    expect(html).not.toContain("ercot_postings.id")
    expect(html).toMatch(/Baseline postings<\/dt><dd>Not reported/)
  })

  it("says not reported for a missing zone price, like every other missing value", () => {
    const html = drawer(session({ provenance: { ...provenance, zone_prices: { ...provenance.zone_prices, zones: { West: 20, North: 25, South: 30 } } } }))
    expect(html).toMatch(/Houston price<\/dt><dd>Not reported/)
    expect(html).not.toContain("no price")
    expect(html).toMatch(/West price<\/dt><dd>\$20\.00\/MWh/)
  })
})

describe("Starting charge (gap 15)", () => {
  it("labels each bin, colours bins under the base floor and lists the start stats", () => {
    const html = renderToStaticMarkup(createElement(StartCharge, { start }))
    expect(html).toContain("replay-hist-label")
    expect(html).toContain(">0<")
    expect(html).toContain(">90<")
    expect((html.match(/is-under/g) ?? []).length).toBe(2)
    expect(html).toMatch(/Seed<\/dt><dd>4242/)
    expect(html).toContain("uniform 5 to 95% of 13.5 kWh")
    expect(html).toContain("6.2% to 94.1% (mean 48.3%)")
    expect(html).toContain("Under 20% floor")
    expect(html).toContain("West 2 · North 4 · South 0 · Houston 0")
    expect(html).toContain("13.5 kWh · 5 kW (example, not Base specs)")
    expect(html).toContain("Empty to full at 5 kW")
  })

  it("shows the worker's real seed-42 start: three bins wholly under the 30% floor, and the pack it ran", () => {
    const html = renderToStaticMarkup(createElement(StartCharge, { start: realStart }))
    expect((html.match(/is-under/g) ?? []).length).toBe(3)
    expect(html).toContain("uniform 10 to 95% of 25 kWh")
    expect(html).toContain("West 7 · North 7 · South 9 · Houston 5")
    expect(html).toContain("25 kWh · 11.4 kW (example, not Base specs)")
    expect(html).toContain("Amber bins lie wholly under the 30% base floor.")
  })

  it("does not colour a bin that straddles the floor", () => {
    const html = renderToStaticMarkup(createElement(StartCharge, { start: { ...realStart, base_floor_pct: 25 } }))
    expect((html.match(/is-under/g) ?? []).length).toBe(2)
  })

  it("gives the histogram an accessible name that carries every bin's count", () => {
    const html = renderToStaticMarkup(createElement(StartCharge, { start: realStart }))
    const doc = new DOMParser().parseFromString(html, "text/html")
    const hist = doc.querySelector(".replay-hist")!
    expect(hist.getAttribute("role")).toBe("img")
    const label = hist.getAttribute("aria-label") ?? ""
    expect(label).toContain("Starting charge of 100 batteries")
    expect(label).toContain("0 to 10%: 0")
    expect(label).toContain("10 to 20%: 15")
    expect(label).toContain("90 to 100%: 7")
  })

  it("is shown in the drawer", () => {
    expect(drawer(session())).toContain("uniform 5 to 95% of 13.5 kWh")
  })
})

describe("About this data: overlays (gap 16)", () => {
  it("names the tape overlay and grid-down zones as hand-placed", () => {
    const html = drawer(session())
    expect(html).toContain("Overlays (hand-placed)")
    expect(html).toContain("Tick 3: Houston feed dropped by hand")
    expect(html).toContain("Grid down in Houston. Operator overlay, not an archive row.")
  })

  it("says none when there is no overlay", () => {
    const html = drawer(session({ grid_down_zones: [], provenance: { ...provenance, archive_rows: null } }))
    expect(html).toContain("None this tick.")
  })
})

describe("About this data: engine decision (gap 17)", () => {
  it("shows per-zone floors, what the fleet did in words, mode, the reasons list, breaches and the brief", () => {
    const html = drawer(session())
    expect(html).toContain("Engine decision this tick")
    expect(html).toMatch(/Houston floor<\/dt><dd>60% · NWS weather alert/)
    expect(html).toMatch(/North floor<\/dt><dd>30% · Base floor/)
    expect(html).toMatch(/Fleet did<\/dt><dd>Charge — served the call, then charged/)
    expect(html).not.toContain("grid_call_served")
    expect(html).toContain("Automatic: the engine decides")
    expect(html).toContain("Charging, Homes stale:1")
    expect(html).toMatch(/Breaches<\/dt><dd>0/)
    expect(html).toContain("Delivered 0.02 of 0.02 MW. Floor 30% (Houston 60%: weather_alert)")
  })

  it("lists each county floor under its zone (Beryl tick 22: Harris 60%, the other four Houston counties 30%)", () => {
    const rows = dataRows(drawer(session()))
    const houston = rows.indexOf("Houston floor: 60% · NWS weather alert")
    expect(houston).toBeGreaterThan(-1)
    expect(rows.slice(houston + 1, houston + 6)).toEqual([
      "Harris (48201): 60% · NWS alert, JEV yes",
      "Fort Bend (48157): 30% · County not named by the alert (base floor)",
      "Brazoria (48039): 30% · County not named by the alert (base floor)",
      "Galveston (48167): 30% · County not named by the alert (base floor)",
      "Montgomery (48339): 30% · County not named by the alert (base floor)",
    ])
    const north = rows.indexOf("North floor: 30% · Base floor")
    expect(rows[north + 1]).toBe("South floor: 30% · Base floor")
  })

  it("lists JEV-no counties at the base floor (Heather tick 2)", () => {
    const rows = dataRows(drawer(session({ scenario: heatherScenario, tick: heatherTick2, alerts: [dallasFreeze, harrisFreeze] })))
    const north = rows.indexOf("North floor: 30% · Base floor")
    expect(rows.slice(north + 1, north + 5)).toEqual([
      "Dallas (48113): 30% · NWS alert, JEV no (base floor)",
      "Tarrant (48439): 30% · NWS alert, JEV no (base floor)",
      "Collin (48085): 30% · NWS alert, JEV no (base floor)",
      "Denton (48121): 30% · NWS alert, JEV no (base floor)",
    ])
  })

  it("names a real operator hold truthfully: the fleet stopped, no selling and no charging", () => {
    const html = drawer(session({ tick: holdTick, alerts: [] }))
    expect(html).toMatch(/Mode<\/dt><dd>Hold: the operator stopped the fleet \(no selling, no charging\)/)
    expect(html).not.toContain("paused selling")
    expect(html).toMatch(/Fleet did<\/dt><dd>Hold — operator hold/)
    expect(html).toContain("Operator hold")
  })

  it("names a real automatic sale for the grid call in words", () => {
    const html = drawer(session({ tick: dischargeTick, alerts: [] }))
    expect(html).toMatch(/Fleet did<\/dt><dd>Sell — sold for the grid call/)
    expect(html).toMatch(/Mode<\/dt><dd>Automatic: the engine decides/)
  })

  it("shows an unknown mode code as it came and says no tick yet without one", () => {
    expect(drawer(session({ tick: { ...berylTick22, mode: "DRILL" } }))).toMatch(/Mode<\/dt><dd>DRILL/)
    expect(drawer(session({ tick: { ...berylTick22, reasons: [] } }))).toMatch(/Reasons<\/dt><dd>None/)
    expect(drawer(session({ tick: null }))).toContain("No tick played yet.")
  })
})

describe("Session log (gap 18)", () => {
  it("lists the worker's log newest first", () => {
    const html = renderToStaticMarkup(createElement(SessionLog, { log: session().log }))
    const refused = html.indexOf("refused alert")
    const started = html.indexOf("started Beryl landfall")
    expect(refused).toBeGreaterThan(-1)
    expect(started).toBeGreaterThan(refused)
  })

  it("shows each line's worker time as a short UTC clock and keeps the full stamp for machines", () => {
    const html = renderToStaticMarkup(createElement(SessionLog, { log: session().log }))
    expect(html).toContain('dateTime="2026-09-26T10:00:00Z"')
    expect(html).toContain(">Sep 26 10:00:00 UTC<")
    const odd = renderToStaticMarkup(createElement(SessionLog, { log: [{ at: "2026-09-27T05:25:48+00:00", text: "a" }, { at: "later", text: "b" }] }))
    expect(odd).toContain(">Sep 27 05:25:48 UTC<")
    expect(odd).toContain(">later<")
  })

  it("says what it covers: the worker's last 12 lines, on its wall clock in UTC", () => {
    const html = renderToStaticMarkup(createElement(SessionLog, { log: session().log }))
    expect(html).toContain("The worker keeps its last 12 lines. Times are its wall clock in UTC, not scenario time.")
  })

  it("says nothing is logged when the log is empty, and is in the drawer", () => {
    expect(renderToStaticMarkup(createElement(SessionLog, { log: [] }))).toContain("Nothing logged yet.")
    expect(drawer(session())).toContain("fleet seeded (seed 4242)")
  })
})

describe("Zone shares (gap 20)", () => {
  it("shows each zone's confirmed sale, share of fleet and charging", () => {
    const html = renderToStaticMarkup(createElement(ZoneShares, { zones: session().zones }))
    expect(html).toContain("0.150 MW sold")
    expect(html).toContain("60% of fleet")
    expect(html).toContain("0.020 MW charging")
    expect(html).toMatch(/Houston[\s\S]*Not reported/)
  })

  it("says no share when the fleet sold nothing, and is in the drawer", () => {
    const zones = { West: { ...session().zones.West!, selling_mw: 0 } }
    expect(renderToStaticMarkup(createElement(ZoneShares, { zones }))).toContain("No confirmed sale this tick")
    expect(drawer(session())).toContain("60% of fleet")
  })
})

describe("Scenario rail parity (gaps 3, 7, 8, 23)", () => {
  let host: HTMLDivElement
  let root: Root
  let sent: FlowRequest[]

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement("div")
    document.body.appendChild(host)
    root = createRoot(host)
    sent = []
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  function render(state: SessionState | null) {
    act(() => root.render(createElement(ScenarioRail, {
      scenarios, state, lens: "send", onLens: () => {}, onSend: (request: FlowRequest) => { sent.push(request) },
    })))
  }

  function button(text: string): HTMLButtonElement {
    const found = [...host.querySelectorAll("button")].find((b) => b.textContent === text)
    if (!found) throw new Error(`no button ${text}`)
    return found
  }

  function typeSeed(value: string) {
    const input = host.querySelector<HTMLInputElement>("input[name='seed']")!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
    act(() => {
      setter.call(input, value)
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
  }

  it("sends the typed seed with start and with reshuffle, and shows the session seed", () => {
    render(session())
    expect(host.textContent).toContain("Seed in use: 42")
    typeSeed("77")
    const calm = [...host.querySelectorAll<HTMLButtonElement>(".replay-scenario")].find((b) => b.querySelector(".title")?.textContent === "Calm day: charge at noon, sell at the peak")!
    act(() => calm.click())
    act(() => button("Reshuffle batteries").click())
    expect(sent).toEqual([
      { kind: "start", body: { scenario: "calm-charge", seed: 77 } },
      { kind: "reset", body: { seed: 77 } },
    ])
  })

  it("leaves the seed out when blank so the worker picks one, and disables reshuffle without a scenario", () => {
    render(session())
    act(() => button("Reshuffle batteries").click())
    expect(sent).toEqual([{ kind: "reset", body: {} }])
    render(null)
    expect(button("Reshuffle batteries").disabled).toBe(true)
    expect(host.textContent).not.toContain("Seed in use")
  })

  it("lets the user pick which archived alert the weather step sends", () => {
    render(session({ scenario: heatherScenario, tick: heatherTick2, alerts: [], grid_down_zones: [] }))
    const select = host.querySelector<HTMLSelectElement>("select[name='alert']")!
    expect(select.options.length).toBe(2)
    act(() => {
      select.value = HARRIS_ID
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    act(() => button("Alert").click())
    expect(sent).toEqual([{ kind: "alert", body: { alert_id: HARRIS_ID } }])
  })

  it("marks sent alerts and can send a second archived alert", () => {
    render(session({ scenario: heatherScenario, tick: heatherTick2, alerts: [dallasFreeze], grid_down_zones: [] }))
    const select = host.querySelector<HTMLSelectElement>("select[name='alert']")!
    const sentOption = [...select.options].find((o) => o.value === DALLAS_ID)!
    expect(sentOption.disabled).toBe(true)
    expect(sentOption.textContent).toContain("(sent)")
    expect(select.value).toBe(HARRIS_ID)
    act(() => button("Send this alert").click())
    expect(sent).toEqual([{ kind: "alert", body: { alert_id: HARRIS_ID } }])
  })

  it("offers grid down only when the scenario has the overlay, with the overlay note and down zones", () => {
    render(session())
    expect(host.textContent).toContain("Alert + grid down")
    expect(host.textContent).toContain("Grid down is an operator overlay, not archive data.")
    expect(host.textContent).toContain("Down now: Houston.")
    render(session({ scenario: heatherScenario, tick: heatherTick2, alerts: [], grid_down_zones: [] }))
    expect(host.textContent).toContain("Alert")
    expect(host.textContent).not.toContain("Alert + grid down")
    expect(host.textContent).not.toContain("operator overlay")
  })

  it("shows the worker's tick error", () => {
    render(session({ status: "error", error: "tape row 4 unreadable" }))
    const alertBox = host.querySelector("[role='alert']")
    expect(alertBox?.textContent).toContain("Tick failed: tape row 4 unreadable")
    render(session())
    expect(host.querySelector("[role='alert']")).toBeNull()
  })
})
