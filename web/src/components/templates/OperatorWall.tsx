import { useState } from "react"
import { useApiHealth } from "../../api/health"
import { calmStreak } from "../../calmStreak"
import type { RunFile } from "../../contracts"
import { scenes, type SceneId } from "../../fixtures/scenes"
import { reserveBanner } from "../../format"
import { stampTick, useLiveStamp } from "../../liveStamp"
import { stormTickIndex } from "../../loadRun"
import { AckRail } from "../organisms/AckRail"
import { ControlBar } from "../organisms/ControlBar"
import { FleetBoard } from "../organisms/FleetBoard"
import { SideRail } from "../organisms/SideRail"
import { TopStrip } from "../organisms/TopStrip"

type OperatorWallProps = {
  run: RunFile
}

type WallScene = SceneId | "high"

export function OperatorWall({ run }: OperatorWallProps) {
  const highIndex = stormTickIndex(run)
  const [selected, setSelected] = useState(highIndex)
  const [scene, setScene] = useState<WallScene | null>(null)
  const [radar, setRadar] = useState(false)
  const [ackRound, setAckRound] = useState(0)
  const live = useLiveStamp()
  const api = useApiHealth()
  const overlay = scenes.find((item) => item.id === scene)
  // Scenes are staged failures, so the live stamp only lands on tape ticks.
  const tick = overlay?.tick ?? stampTick(run.ticks[selected] ?? run.ticks[0], live)
  const quality = overlay?.quality ?? "ok"
  const banner = reserveBanner(tick, quality)
  // A scene is a staged tick with no history, so it is counted on its own.
  const calm = overlay ? calmStreak([overlay.tick], quality) : calmStreak(run.ticks.slice(0, selected + 1))

  function showScene(next: WallScene) {
    if (next === "high") {
      setSelected(highIndex)
    }
    setScene(next)
    setAckRound((round) => round + 1)
  }

  return (
    <main className={banner ? "wall has-banner" : "wall"}>
      <TopStrip
        tick={tick}
        runId={run.run_id}
        tickCount={run.ticks.length}
        calm={calm}
        sceneLabel={overlay?.label}
        api={api}
      />
      {banner ? (
        <p className="fail-banner" role="status">
          {banner}
        </p>
      ) : null}
      <div className="wall-body" key={overlay?.id ?? tick.tick}>
        <div className="wall-main">
          <FleetBoard tick={tick} radar={radar} />
          <AckRail key={ackRound} tick={tick} />
        </div>
        <SideRail
          brief={tick.brief}
          reasons={tick.reasons}
          decisionLine={run.decision_line}
          tick={tick.tick}
          tickCount={run.ticks.length}
          quality={quality}
          stamp={overlay ? `quality: ${quality} · ${overlay.label}` : undefined}
        />
      </div>
      <ControlBar
        mode={tick.mode}
        ticks={run.ticks}
        selected={overlay ? -1 : selected}
        scene={scene}
        radar={radar}
        onSelect={(index) => {
          setScene(null)
          setSelected(index)
        }}
        onScene={showScene}
        onRadar={() => {
          setRadar((on) => !on)
        }}
      />
    </main>
  )
}
