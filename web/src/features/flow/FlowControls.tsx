import { useState } from "react"
import type { FlowRequest } from "./api"
import {
  WEATHER_STEP_LABEL,
  chosenAlertId,
  currentWeatherStep,
  fmtScenarioTime,
  timeLapseLabel,
  weatherStepRequests,
  type WeatherStep,
} from "./flowMath"
import type { ScenarioList, SessionState } from "./types"

const WEATHER_STEPS: WeatherStep[] = ["none", "alert", "alert_grid_down"]

type StepProps = { state: SessionState; alertId: string; onSend: (request: FlowRequest) => void }

/** None, alert, or alert plus grid down, sent as the existing alert and grid-down requests. */
export function WeatherSteps({ state, alertId, onSend }: StepProps) {
  const current = currentWeatherStep(state)
  return (
    <div className="flow-control-group flow-weather-steps">
      <span className="flow-field-label">Weather step</span>
      <div role="radiogroup" aria-label="Weather step">
        {WEATHER_STEPS.map((step) => {
          const plan = weatherStepRequests(step, state, alertId)
          const on = step === current
          const classes = ["flow-button", on ? "is-primary" : "", step === "alert_grid_down" ? "is-down" : step === "alert" ? "is-warn" : ""]
          return (
            <button key={step} type="button" role="radio" aria-checked={on} className={classes.filter(Boolean).join(" ")}
              disabled={!on && "blocked" in plan} title={"blocked" in plan ? plan.blocked : undefined}
              onClick={() => { if ("requests" in plan) plan.requests.forEach(onSend) }}>
              {WEATHER_STEP_LABEL[step]}
            </button>
          )
        })}
      </div>
      <p className="flow-muted">
        Grid down is an operator overlay, not archive data. Its batteries back up their own homes: no selling, no charging.
        {state.grid_down_zones.length ? ` Down now: ${state.grid_down_zones.join(", ")}.` : ""}
      </p>
    </div>
  )
}

type Props = {
  scenarios: ScenarioList | null
  state: SessionState | null
  onSend: (request: FlowRequest) => void
}

function seedOrUndefined(text: string): number | undefined {
  const value = Number.parseInt(text, 10)
  return Number.isFinite(value) && value >= 1 ? value : undefined
}

export function FlowControls({ scenarios, state, onSend }: Props) {
  const list = scenarios?.scenarios ?? []
  const [picked, setPicked] = useState<string>("")
  const [seedText, setSeedText] = useState("")
  const [alertId, setAlertId] = useState("")
  const active = state?.scenario ?? null
  const scenarioId = picked || active?.id || list[0]?.id || ""
  const alerts = active?.alerts ?? []
  const sent = new Set((state?.alerts ?? []).map((a) => a.id))
  const chosenAlert = chosenAlertId(alerts, sent, alertId)
  const playing = state?.status === "playing"
  const speeds = state?.speeds ?? scenarios?.speeds ?? []

  return (
    <div className="flow-controls">
      <div className="flow-control-group">
        <label className="flow-field">
          <span>Scenario</span>
          <select value={scenarioId} onChange={(event) => setPicked(event.target.value)}>
            {list.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select>
        </label>
        <label className="flow-field flow-field-seed">
          <span>Seed (blank = random)</span>
          <input inputMode="numeric" value={seedText} placeholder="random"
            onChange={(event) => setSeedText(event.target.value.replace(/[^0-9]/g, ""))} />
        </label>
        <button type="button" className="flow-button is-primary" disabled={!scenarioId}
          onClick={() => onSend({ kind: "start", body: { scenario: scenarioId, seed: seedOrUndefined(seedText) } })}>
          Start
        </button>
      </div>

      <div className="flow-control-group">
        <button type="button" className="flow-button" disabled={!active}
          onClick={() => onSend({ kind: "play", body: { playing: !playing } })}>
          {playing ? "Pause" : "Play"}
        </button>
        <button type="button" className="flow-button" disabled={!active}
          onClick={() => onSend({ kind: "reset", body: { seed: seedOrUndefined(seedText) } })}>
          Reshuffle batteries
        </button>
        <label className="flow-field">
          <span>Speed</span>
          <select value={state?.speed ?? scenarios?.default_speed ?? ""} disabled={!active}
            onChange={(event) => onSend({ kind: "speed", body: { x: Number(event.target.value) } })}>
            {speeds.map((x) => <option key={x} value={x}>{timeLapseLabel(x, state?.tick_minutes ?? 5)}</option>)}
          </select>
        </label>
      </div>

      <div className="flow-control-group">
        <label className="flow-field flow-field-wide">
          <span>Archived NWS alert</span>
          <select value={chosenAlert} disabled={!alerts.length} onChange={(event) => setAlertId(event.target.value)}>
            {alerts.length ? alerts.map((a) => (
              <option key={a.id} value={a.id} disabled={sent.has(a.id)}>
                {a.event} · {a.areaDesc ?? a.id}{sent.has(a.id) ? " (sent)" : ""}
              </option>
            )) : <option value="">No archived alert for this scenario</option>}
          </select>
        </label>
        <button type="button" className="flow-button is-warn" disabled={!chosenAlert || sent.has(chosenAlert)}
          onClick={() => onSend({ kind: "alert", body: { alert_id: chosenAlert } })}>
          Send alert
        </button>
      </div>

      {active?.grid_down_overlay && state ? <WeatherSteps state={state} alertId={chosenAlert} onSend={onSend} /> : null}

      {state?.scenario ? (
        <p className="flow-progress">
          Tick {state.tick_index} of {state.tick_count} · {fmtScenarioTime(state.tick?.ts)} · {state.status}
        </p>
      ) : null}
    </div>
  )
}
