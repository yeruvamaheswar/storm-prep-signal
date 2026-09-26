import type { Mode, TickView } from "../../contracts"
import type { IntervalPoint } from "../../intervalSeries"
import type { RuntimeMode } from "../../runtimeMode"
import type { SceneId } from "../../fixtures/scenes"
import type { LoadZone } from "../../zonePaint"
import { Button } from "../atoms/Button"
import { IntervalStrip } from "./IntervalStrip"
import { modeTickIndex } from "./modeTicks"
import { TapeScrubber } from "./TapeScrubber"

type WallScene = SceneId | "high"

type ControlBarProps = {
  mode: Mode
  ticks: TickView[]
  selected: number
  scene: WallScene | null
  radar: boolean
  onSelect: (index: number) => void
  onScene: (scene: WallScene) => void
  onMode: (mode: Mode) => void
  onRadar: () => void
  zone?: LoadZone | null
  zoneTick?: TickView
  runtime?: RuntimeMode
  intervals?: readonly IntervalPoint[]
  liveSelectable?: boolean
  onRuntime?: (mode: RuntimeMode) => void
  /** 01–12 tape chrome. False for live and archive-clocked sources. */
  showTapeChrome?: boolean
}

export function ControlBar({
  mode,
  ticks,
  selected,
  scene,
  radar,
  onSelect,
  onScene,
  onMode,
  onRadar,
  zone = null,
  zoneTick,
  runtime = "demo",
  intervals = [],
  liveSelectable = false,
  onRuntime,
  showTapeChrome,
}: ControlBarProps) {
  const tape = showTapeChrome ?? runtime !== "live"
  const live = runtime === "live"

  return (
    <footer className="control-bar">
      <div className="controls">
        <span className="control-label" id="run-label">
          Run
        </span>
        <div className="mode-keys" role="group" aria-labelledby="run-label">
          <Button
            pressed={live}
            disabled={!liveSelectable}
            label="Live. Follow the ERCOT clock."
            onClick={() => {
              onRuntime?.("live")
            }}
          >
            Live
          </Button>
          <Button
            pressed={!live}
            label="Demo. Play the 12-tick tape."
            onClick={() => {
              onRuntime?.("demo")
            }}
          >
            Demo
          </Button>
        </div>
        <span className="control-label" id="mode-label">
          Mode
        </span>
        <div className="mode-keys" role="group" aria-labelledby="mode-label">
          <Button
            pressed={mode === "HOLD"}
            armed={mode === "HOLD"}
            disabled={!live && modeTickIndex(ticks, "HOLD", selected) === null}
            label="Hold. Discharge stays at zero until Auto."
            onClick={() => {
              onMode("HOLD")
            }}
          >
            Hold
          </Button>
          <Button
            pressed={mode === "AUTO"}
            label="Auto. The controller dispatches to live homes."
            onClick={() => {
              onMode("AUTO")
            }}
          >
            Auto
          </Button>
        </div>
        <span className="control-label" id="scenario-label">
          {live ? "Overlay" : "Scenario"}
        </span>
        <div className="scene-keys" role="group" aria-labelledby="scenario-label">
          {live ? null : (
            <Button
              pressed={scene === "failsafe"}
              label="Fail-safe. The outage report timed out, so the floor rises and discharge stops."
              onClick={() => {
                onScene("failsafe")
              }}
            >
              Fail-safe
            </Button>
          )}
          {live ? null : (
            <Button
              pressed={scene === "high"}
              label="High risk. Opens the storm tick, then the tick where homes go offline."
              onClick={() => {
                onScene("high")
              }}
            >
              High risk
            </Button>
          )}
          <Button pressed={radar} label="NWS radar" onClick={onRadar}>
            Radar
          </Button>
          {live ? null : (
            <Button
              pressed={scene === "devices"}
              label="15 percent offline. Silent homes get no work. Live homes keep the rest."
              onClick={() => {
                onScene("devices")
              }}
            >
              15% offline
            </Button>
          )}
        </div>
      </div>
      {live ? (
        <IntervalStrip intervals={intervals} />
      ) : (
        <TapeScrubber
          ticks={ticks}
          selected={selected}
          scene={scene}
          onSelect={onSelect}
          zone={zone}
          zoneTick={zoneTick}
        />
      )}
    </footer>
  )
}
