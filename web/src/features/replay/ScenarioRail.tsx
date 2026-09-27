import { useEffect, useRef, useState } from "react"
import type { FlowRequest } from "../flow/api"
import { WEATHER_STEP_LABEL, currentWeatherStep, weatherStepRequests, type WeatherStep } from "../flow/flowMath"
import type { ScenarioList, SessionState } from "../flow/types"
import { oneLine } from "./format"

type Lens = "send" | "keep" | "trust"

type Props = {
  scenarios: ScenarioList | null
  scenariosFailed?: boolean
  state: SessionState | null
  lens: Lens
  onLens: (lens: Lens) => void
  onSend: (request: FlowRequest) => void
}

const LENSES: Array<{ key: Lens; title: string; body: string }> = [
  { key: "send", title: "Send", body: "Where the orders went" },
  { key: "keep", title: "Keep", body: "What protected each home's backup" },
  { key: "trust", title: "Trust", body: "Which homes answered, and honestly" },
]

const WEATHER_STEPS: WeatherStep[] = ["none", "alert", "alert_grid_down"]

/** A typed seed of 1 or more, or undefined so the worker draws a random one. */
function seedOrUndefined(text: string): number | undefined {
  const value = Number.parseInt(text, 10)
  return Number.isFinite(value) && value >= 1 ? value : undefined
}

function withSeed<T extends object>(body: T, seed: number | undefined): T & { seed?: number } {
  return seed === undefined ? body : { ...body, seed }
}

export function ScenarioRail({ scenarios, scenariosFailed = false, state, lens, onLens, onSend }: Props) {
  const activeId = state?.scenario?.id
  const listRef = useRef<HTMLDivElement | null>(null)
  const [seedText, setSeedText] = useState("")
  const [pickedAlert, setPickedAlert] = useState("")
  const seed = seedOrUndefined(seedText)
  const activeAlerts = state?.scenario?.alerts ?? []
  const sent = new Set((state?.alerts ?? []).map((alert) => alert.id))
  const picked = activeAlerts.some((alert) => alert.id === pickedAlert && !sent.has(alert.id)) ? pickedAlert : ""
  const alertId = picked || (activeAlerts.find((alert) => !sent.has(alert.id))?.id ?? activeAlerts[0]?.id ?? "")
  const unsentAlert = alertId && !sent.has(alertId) ? alertId : ""
  const gridDownOverlay = !!state?.scenario?.grid_down_overlay
  const steps = gridDownOverlay ? WEATHER_STEPS : WEATHER_STEPS.filter((step) => step !== "alert_grid_down")
  const weather = state ? currentWeatherStep(state) : "none"
  const tickError = state && (state.error || state.status === "error") ? state.error ?? "No reason reported" : null

  // Keep the active scenario visible inside the rail's own scroll area. This never scrolls the page.
  useEffect(() => {
    const list = listRef.current
    const active = list?.querySelector<HTMLElement>(".replay-scenario.on")
    if (!list || !active) return
    const top = active.offsetTop
    const bottom = top + active.offsetHeight
    if (top < list.scrollTop || bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = Math.max(0, top - (list.clientHeight - active.offsetHeight) / 2)
    }
  }, [activeId, scenarios])

  return (
    <>
      <section className="replay-panel replay-scenarios" aria-label="Scenarios">
        <p className="replay-label">Pick a scenario to replay</p>
        <div className="replay-scenario-list" ref={listRef}>
          {(scenarios?.scenarios ?? []).map((scenario) => (
            <button
              className={scenario.id === activeId ? "replay-scenario on" : "replay-scenario"}
              aria-current={scenario.id === activeId ? "true" : undefined}
              key={scenario.id}
              type="button"
              onClick={() => onSend({ kind: "start", body: withSeed({ scenario: scenario.id }, seed) })}
            >
              <span className="title">{scenario.name}</span>
              <span className="story" title={oneLine(scenario.summary)}>{oneLine(scenario.summary)}</span>
            </button>
          ))}
          {scenariosFailed ? <p className="replay-empty-small">Cannot load the scenario list from the API.</p> : null}
          {!scenariosFailed && scenarios && scenarios.scenarios.length === 0 ? <p className="replay-empty-small">No scenarios reported.</p> : null}
        </div>
        {tickError ? <p className="replay-rail-error" role="alert">Tick failed: {tickError}</p> : null}
        <div className="replay-seed">
          <label className="replay-label" htmlFor="replay-seed-input">Seed (blank = random)</label>
          <div className="replay-seed-row">
            <input
              id="replay-seed-input"
              name="seed"
              inputMode="numeric"
              placeholder="random"
              value={seedText}
              onChange={(event) => setSeedText(event.target.value.replace(/[^0-9]/g, ""))}
            />
            <button
              type="button"
              className="replay-pill replay-pill-secondary"
              disabled={!state?.scenario}
              title="New random fleet for this scenario, back to the first tick. Clears sent alerts and grid down."
              onClick={() => onSend({ kind: "reset", body: withSeed({}, seed) })}
            >
              Reshuffle batteries
            </button>
          </div>
          {state?.scenario ? <p className="replay-seed-now">Seed in use: {state.seed ?? "Not reported"}</p> : null}
        </div>
        {gridDownOverlay || activeAlerts.length ? (
          <div className="replay-weather">
            <p className="replay-label">Weather step</p>
            {activeAlerts.length > 1 ? (
              <div className="replay-alert-pick">
                <label className="replay-label" htmlFor="replay-alert-select">Archived alert to send</label>
                <select id="replay-alert-select" name="alert" value={alertId} onChange={(event) => setPickedAlert(event.target.value)}>
                  {activeAlerts.map((alert) => (
                    <option key={alert.id} value={alert.id} disabled={sent.has(alert.id)}>
                      {`${alert.event ?? alert.id} · ${alert.areaDesc ?? alert.id}${sent.has(alert.id) ? " (sent)" : ""}`}
                    </option>
                  ))}
                </select>
                {state?.alerts.length ? (
                  <button
                    type="button"
                    className="replay-pill replay-pill-secondary"
                    disabled={!unsentAlert}
                    onClick={() => onSend({ kind: "alert", body: { alert_id: unsentAlert } })}
                  >
                    Send this alert
                  </button>
                ) : null}
              </div>
            ) : null}
            <div className="replay-weather-buttons" role="radiogroup" aria-label="Weather step">
              {steps.map((step) => {
                const plan = state && alertId ? weatherStepRequests(step, state, alertId) : { blocked: "No session" }
                const blocked = "blocked" in plan
                return (
                  <button
                    key={step}
                    type="button"
                    role="radio"
                    aria-checked={weather === step}
                    disabled={blocked && weather !== step}
                    title={blocked ? plan.blocked : undefined}
                    className={weather === step ? "on" : undefined}
                    onClick={() => { if ("requests" in plan) plan.requests.forEach(onSend) }}
                  >
                    {WEATHER_STEP_LABEL[step]}
                  </button>
                )
              })}
            </div>
            {gridDownOverlay ? (
              <p className="replay-note">
                Grid down is an operator overlay, not archive data. Its batteries back up their own homes: no selling, no charging.
                {state?.grid_down_zones.length ? ` Down now: ${state.grid_down_zones.join(", ")}.` : ""}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="replay-panel replay-lens" aria-label="Lens">
        <p className="replay-label">What to show</p>
        <div>
          {LENSES.map((item) => (
            <button key={item.key} type="button" aria-pressed={lens === item.key} className={lens === item.key ? "on" : undefined} onClick={() => onLens(item.key)}>
              <b>{item.title}</b>
              <span>{item.body}</span>
            </button>
          ))}
        </div>
      </section>
    </>
  )
}

export type { Lens }
