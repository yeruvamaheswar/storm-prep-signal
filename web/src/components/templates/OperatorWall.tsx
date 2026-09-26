import { useCallback, useEffect, useState } from "react"
import { createClient } from "../../api/client"
import { apiBaseUrl, useApiHealth } from "../../api/health"
import { calmStreak } from "../../calmStreak"
import type { Mode, RunFile, WallMeta } from "../../contracts"
import { feedChip, formatTs } from "../../format"
import { scenes, type SceneId } from "../../fixtures/scenes"
import { liveSafeTick, useLiveStamp } from "../../liveStamp"
import { loadFeedCatalog, readSuppliedFeeds, reportFeeds, type FeedProduct } from "../../reportFeeds"
import { isArchiveEvent, loadMeta, requestedMode, resolveWallEvent, stormTickIndex } from "../../loadRun"
import { stressReading } from "../../stressReading"
import { fleetIntent, type FleetAction } from "../../fleetIntent"
import {
  ercotIntervalLabel,
  ingestHealth,
  liveRailStamp,
  liveSelectable,
  readingForMode,
  resolveRuntimeMode,
  type RuntimeMode,
} from "../../runtimeMode"
import { wallOrigin } from "../../wallOrigin"
import { planModeChange } from "../../wallMode"
import { outageLine } from "../../wallLines"
import { wallSnapshot } from "../../wallSnapshot"
import { zoneBrief, zoneCallout, zoneFacts } from "../../zoneLens"
import type { LoadZone } from "../../zonePaint"
import { AckRail } from "../organisms/AckRail"
import { ControlBar } from "../organisms/ControlBar"
import { FleetBoard } from "../organisms/FleetBoard"
import { SideRail } from "../organisms/SideRail"
import { TopStrip } from "../organisms/TopStrip"

type OperatorWallProps = {
  run: RunFile
}

type WallScene = SceneId | "high"

function tapeTickClock(run: RunFile, selected: number): string | null {
  const tick = run.ticks[selected] ?? run.ticks[0]
  return typeof tick?.ts === "string" ? tick.ts : null
}

function intentClass(action: FleetAction): string {
  switch (action) {
    case "hold":
      return "intent-banner is-hold"
    case "discharge":
      return "intent-banner"
    default: {
      const neverAction: never = action
      return neverAction
    }
  }
}

export function OperatorWall({ run }: OperatorWallProps) {
  const highIndex = stormTickIndex(run)
  const [selected, setSelected] = useState(highIndex)
  const [scene, setScene] = useState<WallScene | null>(null)
  const [radar, setRadar] = useState(false)
  const [ackRound, setAckRound] = useState(0)
  const [zone, setZone] = useState<LoadZone | null>(null)
  const [choice, setChoice] = useState<RuntimeMode | null>(null)
  const [liveMode, setLiveMode] = useState<Mode | null>(null)
  const [meta, setMeta] = useState<WallMeta | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [catalog, setCatalog] = useState<FeedProduct[]>([])
  const api = useApiHealth()
  const preferred = requestedMode()
  const demoChosen = (choice ?? preferred) === "demo"
  const selectedEvent = resolveWallEvent(
    typeof window === "undefined" ? "" : window.location.search,
    demoChosen,
    meta?.event,
  )
  const archiveOn = isArchiveEvent(selectedEvent)
  const tapeChosen = demoChosen && !archiveOn
  const pollLive = !tapeChosen
  const metaMode = meta?.source === "archive" || archiveOn ? "live" : (meta?.mode ?? null)
  const selectZone = useCallback((next: LoadZone) => {
    setZone(next)
  }, [])
  const clearZone = useCallback(() => {
    setZone(null)
  }, [])
  const watch = useLiveStamp(pollLive, archiveOn ? selectedEvent : null, archiveOn ? null : tapeTickClock(run, selected))
  // The API holds ERCOT keys. A down API, or a failed first snapshot, falls back to Demo.
  const credentials = api.state !== "down"
  const health = ingestHealth(watch.latest === null ? null : watch.latest.quality)
  const sawSuccess = watch.lastOk !== null
  const runtime = resolveRuntimeMode(credentials, health, sawSuccess, choice, preferred, metaMode)
  const canLive = liveSelectable(credentials, health, sawSuccess)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    let cancelled = false
    void loadMeta().then((next) => {
      if (!cancelled && next !== null) setMeta(next)
    })
    return () => {
      cancelled = true
    }
  }, [])
  useEffect(() => {
    let cancelled = false
    void loadFeedCatalog(window.fetch.bind(window), apiBaseUrl()).then((products) => {
      if (!cancelled) setCatalog(products)
    })
    return () => {
      cancelled = true
    }
  }, [api.state])
  const overlay = runtime === "demo" && !archiveOn ? scenes.find((item) => item.id === scene) : undefined
  const tapeTick = run.ticks[selected] ?? run.ticks[0]
  // Demo tape stays fixture-only. Archive and Live read GET /v1/snapshot.
  const liveTick = watch.tick ?? liveSafeTick(tapeTick)
  const engineTick = overlay?.tick ?? (runtime === "live" || archiveOn ? liveTick : tapeTick)
  const tick =
    runtime === "live" && liveMode !== null ? { ...engineTick, mode: liveMode } : engineTick
  const reading = readingForMode(stressReading(tick), runtime)
  const wantedLive = (choice ?? preferred ?? metaMode) !== "demo"
  const fallbackQuality =
    runtime === "demo" && wantedLive && watch.latest !== null && watch.latest.quality !== "ok"
      ? watch.latest.quality
      : null
  const ingestQuality =
    overlay === undefined && (runtime === "live" || fallbackQuality !== null) && watch.latest !== null
      ? watch.latest.quality
      : null
  const quality = overlay?.quality ?? (ingestQuality ?? (runtime === "live" ? reading.quality : "ok"))
  const line = outageLine(reading)
  const intent = fleetIntent(tick, quality, line)
  const sourceHint = tapeChosen
    ? "fixture"
    : archiveOn
      ? "archive"
      : typeof watch.tick?.source === "string"
        ? watch.tick.source
        : (meta?.source ?? null)
  const origin = wallOrigin({
    runtime: tapeChosen ? "demo" : runtime,
    source: sourceHint,
    event: tapeChosen ? null : (archiveOn ? selectedEvent : (typeof watch.tick?.event === "string" ? watch.tick.event : meta?.event)),
    clock: tapeChosen ? null : (archiveOn ? "archive" : (typeof watch.tick?.clock === "string" ? watch.tick.clock : meta?.clock)),
    runId: run.run_id,
    intervalLabel: ercotIntervalLabel(now),
  })
  const feed = origin.kind === "fixture" ? feedChip(tick.target_label, tick.price_label) : "LIVE"
  const supplied = readSuppliedFeeds((tick as typeof tick & { feeds?: unknown }).feeds)
  const feeds = reportFeeds(reading, feed, intent.line, runtime, {
    ingestQuality,
    lastOkAsOf: watch.lastOk?.asOfLabel ?? null,
    supplied,
    catalog,
  })
  const status = feeds.quality
  // A scene is a staged tick with no history. Live is one interval, not a tape prefix.
  const calm =
    runtime === "live" || overlay ? calmStreak([tick], quality) : calmStreak(run.ticks.slice(0, selected + 1))
  const snapshot = wallSnapshot({
    runtime: archiveOn ? "demo" : runtime,
    tick,
    calm,
    watch,
    fallbackQuality,
    zone,
  })
  const lens = zone === null ? null : zoneFacts(tick, zone)
  const brief = lens === null ? snapshot.brief : zoneBrief(lens)
  const stamp =
    runtime === "live"
      ? liveRailStamp(status.label, reading.asOfLabel)
      : overlay
        ? `quality: ${quality} · ${overlay.label}`
        : undefined

  function showScene(next: WallScene) {
    if (runtime === "live") return
    if (next === "high") {
      setSelected(highIndex)
    }
    setScene(next)
    setAckRound((round) => round + 1)
  }

  function showMode(next: Mode) {
    const plan = planModeChange(runtime, run.ticks, tick.mode, next, selected)
    switch (plan.kind) {
      case "noop":
        if (runtime === "demo") setScene(null)
        return
      case "demo":
        setScene(null)
        setSelected(plan.index)
        return
      case "live":
        setLiveMode(plan.mode)
        void createClient({
          fetch: window.fetch.bind(window),
          baseUrl: `${apiBaseUrl()}/v1`,
          operatorId: "operator-demo",
        }).mode(plan.mode)
        return
      default: {
        const neverPlan: never = plan
        return neverPlan
      }
    }
  }

  function pickRuntime(next: RuntimeMode) {
    if (next === "live" && !canLive) return
    setChoice(next)
    if (next === "live") setScene(null)
    if (next === "demo") setLiveMode(null)
  }

  return (
    <main className="wall has-banner" data-runtime={runtime}>
      <TopStrip
        tick={tick}
        runId={origin.kind === "fixture" ? run.run_id : origin.event ?? origin.kind}
        decisionLine={origin.kind === "fixture" ? run.decision_line : null}
        tickCount={run.ticks.length}
        calm={calm}
        sceneLabel={overlay?.label}
        snapshot={snapshot}
        runtime={runtime}
        intervalLabel={ercotIntervalLabel(now)}
        clockLabel={formatTs(new Date(now).toISOString())}
        feeds={feeds}
        api={api}
        origin={origin}
      />
      <p className={intentClass(intent.action)} role="status">
        {intent.line}
      </p>
      <div className="wall-body" key={overlay?.id ?? tick.tick}>
        <div className="wall-main">
          <FleetBoard
            tick={tick}
            radar={radar}
            zone={zone}
            callout={lens === null ? null : zoneCallout(lens)}
            calloutTitle={lens === null ? undefined : `${lens.priceCaption}. ${lens.floorCaption}.`}
            onSelectZone={selectZone}
          />
          <AckRail key={ackRound} tick={tick} zone={zone} onSelectZone={selectZone} onClearZone={clearZone} />
        </div>
        <SideRail
          brief={brief}
          reasons={tick.reasons}
          decisionLine={run.decision_line}
          tick={tick.tick}
          tickCount={run.ticks.length}
          feeds={feeds}
          quality={quality}
          stamp={stamp}
        />
      </div>
      <ControlBar
        mode={tick.mode}
        ticks={run.ticks}
        selected={overlay ? -1 : selected}
        scene={scene}
        radar={radar}
        onSelect={(index) => {
          if (!origin.showScrubber) return
          setScene(null)
          setSelected(index)
        }}
        onScene={showScene}
        onMode={showMode}
        onRadar={() => {
          setRadar((on) => !on)
        }}
        zone={zone}
        zoneTick={tick}
        runtime={runtime}
        intervals={origin.showScrubber ? [] : (watch.intervals ?? [])}
        liveSelectable={canLive}
        onRuntime={pickRuntime}
        showTapeChrome={origin.showScrubber}
      />
    </main>
  )
}
