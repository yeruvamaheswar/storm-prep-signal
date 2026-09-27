import type { FlowRequest } from "../flow/api"
import { WEATHER_STEP_LABEL, currentWeatherStep, weatherStepRequests, type WeatherStep } from "../flow/flowMath"
import type { ScenarioList, SessionState } from "../flow/types"
import { oneLine } from "./format"

type Lens = "send" | "keep" | "trust"

type Props = {
  scenarios: ScenarioList | null
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

export function ScenarioRail({ scenarios, state, lens, onLens, onSend }: Props) {
  const activeId = state?.scenario?.id
  const activeAlerts = state?.scenario?.alerts ?? []
  const sent = new Set((state?.alerts ?? []).map((alert) => alert.id))
  const alertId = activeAlerts.find((alert) => !sent.has(alert.id))?.id ?? activeAlerts[0]?.id ?? ""
  const weather = state ? currentWeatherStep(state) : "none"

  return (
    <>
      <section className="replay-panel replay-scenarios" aria-label="Scenarios">
        <p className="replay-label">Pick a scenario to replay</p>
        {(scenarios?.scenarios ?? []).map((scenario) => (
          <button
            className={scenario.id === activeId ? "replay-scenario on" : "replay-scenario"}
            key={scenario.id}
            type="button"
            onClick={() => onSend({ kind: "start", body: { scenario: scenario.id } })}
          >
            <span className="title">{scenario.name}</span>
            <span className="story">{oneLine(scenario.summary)}</span>
          </button>
        ))}
        {scenarios && scenarios.scenarios.length === 0 ? <p className="replay-empty-small">No scenarios reported.</p> : null}
        {state?.scenario?.grid_down_overlay || activeAlerts.length ? (
          <div className="replay-weather">
            <p className="replay-label">Weather step</p>
            <div className="replay-weather-buttons" role="radiogroup" aria-label="Weather step">
              {WEATHER_STEPS.map((step) => {
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
          </div>
        ) : null}
      </section>

      <section className="replay-panel replay-lens" aria-label="Lens">
        <p className="replay-label">What to show</p>
        <div>
          {LENSES.map((item) => (
            <button key={item.key} type="button" className={lens === item.key ? "on" : undefined} onClick={() => onLens(item.key)}>
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
