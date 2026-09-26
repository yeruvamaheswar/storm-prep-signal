import { useCallback, useEffect, useState } from "react"
import { useApiHealth } from "../../api/health"
import { calmStreak } from "../../calmStreak"
import type { Mode, RunFile } from "../../contracts"
import { feedChip, formatTs } from "../../format"
import { scenes, type SceneId } from "../../fixtures/scenes"
import { useLiveStamp, viewTick } from "../../liveStamp"
import { readSuppliedFeeds, reportFeeds } from "../../reportFeeds"
import { stormTickIndex } from "../../loadRun"
import { stressReading } from "../../stressReading"
import { fleetIntent, type FleetAction } from "../../fleetIntent"
import {
  ercotIntervalLabel,
  hasErcotCredentials,
  ingestHealth,
  liveBrief,
  liveRailStamp,
  liveSelectable,
  readingForMode,
  resolveRuntimeMode,
  type RuntimeMode,
} from "../../runtimeMode"
import { outageLine } from "../../wallLines"
import { wallSnapshot } from "../../wallSnapshot"
import { zoneBrief, zoneCallout, zoneFacts } from "../../zoneLens"
import type { LoadZone } from "../../zonePaint"
import { AckRail } from "../organisms/AckRail"
import { ControlBar } from "../organisms/ControlBar"
import { FleetBoard } from "../organisms/FleetBoard"
import { modeTickIndex } from "../organisms/modeTicks"
import { SideRail } from "../organisms/SideRail"
import { TopStrip } from "../organisms/TopStrip"

type OperatorWallProps = {
  run: RunFile
}

type WallScene = SceneId | "high"

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
  const [now, setNow] = useState(() => Date.now())
  const api = useApiHealth()
  const selectZone = useCallback((next: LoadZone) => {
    setZone(next)
  }, [])
  const clearZone = useCallback(() => {
    setZone(null)
  }, [])
  const watch = useLiveStamp()
  const credentials = hasErcotCredentials(
    import.meta.env.VITE_ERCOT_SUBSCRIPTION_KEY,
    import.meta.env.VITE_ERCOT_ID_TOKEN,
  )
  const health = ingestHealth(watch.latest === null ? null : watch.latest.quality)
  const sawSuccess = watch.lastOk !== null
  const runtime = resolveRuntimeMode(credentials, health, sawSuccess, choice)
  const canLive = liveSelectable(credentials, health, sawSuccess)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  const overlay = runtime === "demo" ? scenes.find((item) => item.id === scene) : undefined
  const tapeTick = run.ticks[selected] ?? run.ticks[0]
  // Demo keeps the fixture tick. Live lays the ERCOT pull over it and does not follow the scrubber.
  const tick = overlay?.tick ?? (runtime === "live" ? viewTick(tapeTick, watch) : tapeTick)
  const reading = readingForMode(stressReading(tick), runtime)
  const ingestQuality =
    overlay === undefined && credentials && watch.latest !== null ? watch.latest.quality : null
  const quality = overlay?.quality ?? (ingestQuality ?? (runtime === "live" ? reading.quality : "ok"))
  const line = outageLine(reading)
  const intent = fleetIntent(tick, quality, line)
  const feed = runtime === "live" ? "LIVE" : feedChip(tick.target_label, tick.price_label)
  const supplied = readSuppliedFeeds((tick as typeof tick & { feeds?: unknown }).feeds)
  const feeds = reportFeeds(reading, feed, intent.line, runtime, {
    ingestQuality,
    lastOkAsOf: watch.lastOk?.asOfLabel ?? null,
    supplied,
  })
  const status = feeds.quality
  // A scene is a staged tick with no history. Live is one interval, not a tape prefix.
  const calm =
    runtime === "live" || overlay ? calmStreak([tick], quality) : calmStreak(run.ticks.slice(0, selected + 1))
  const snapshot = wallSnapshot({
    runtime,
    tick: overlay?.tick ?? tapeTick,
    calm,
    watch,
  })
  const lens = zone === null ? null : zoneFacts(tick, zone)
  const brief = lens === null ? (runtime === "live" ? liveBrief(tick, reading.asOfLabel) : tick.brief) : zoneBrief(lens)
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
    if (runtime === "live") return
    if (tick.mode === next) {
      setScene(null)
      return
    }
    const index = modeTickIndex(run.ticks, next, selected)
    if (index === null) {
      return
    }
    setScene(null)
    setSelected(index)
  }

  function pickRuntime(next: RuntimeMode) {
    if (next === "live" && !canLive) return
    setChoice(next)
    if (next === "live") setScene(null)
  }

  return (
    <main className="wall has-banner" data-runtime={runtime}>
      <TopStrip
        tick={tick}
        runId={run.run_id}
        decisionLine={run.decision_line}
        tickCount={run.ticks.length}
        calm={calm}
        sceneLabel={overlay?.label}
        snapshot={snapshot}
        runtime={runtime}
        intervalLabel={ercotIntervalLabel(now)}
        clockLabel={formatTs(new Date(now).toISOString())}
        feeds={feeds}
        api={api}
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
          if (runtime === "live") return
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
        intervals={[]}
        liveSelectable={canLive}
        onRuntime={pickRuntime}
      />
    </main>
  )
}
