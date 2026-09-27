import type { Lens } from "./ScenarioRail"

export type PhoneSheet = "setup" | "fleet" | null

type Props = {
  lens: Lens
  onLens: (lens: Lens) => void
  sheet: PhoneSheet
  onSheet: (sheet: PhoneSheet) => void
  /** Left-sheet opener: "Scenario" on Replay, "Inputs" on Live. */
  setupLabel: string
  /** Right-sheet opener. Omit or set showFleet false when there is no fleet panel. */
  fleetLabel?: string
  showFleet?: boolean
}

const LENSES: Array<{ key: Lens; title: string }> = [
  { key: "send", title: "Send" },
  { key: "keep", title: "Keep" },
  { key: "trust", title: "Trust" },
]

/** Phone-only dock: compact lens + sheet openers. Hidden on desktop via CSS. */
export function PhoneChrome({
  lens, onLens, sheet, onSheet, setupLabel, fleetLabel = "This tick", showFleet = true,
}: Props) {
  function toggle(next: Exclude<PhoneSheet, null>) {
    onSheet(sheet === next ? null : next)
  }

  return (
    <>
      {sheet ? (
        <button
          type="button"
          className="replay-phone-scrim"
          aria-label="Close panel"
          onClick={() => onSheet(null)}
        />
      ) : null}
      <div className="replay-phone-chrome">
        <div className="replay-phone-lens" role="radiogroup" aria-label="What to show">
          {LENSES.map((item) => (
            <button
              key={item.key}
              type="button"
              role="radio"
              aria-checked={lens === item.key}
              className={lens === item.key ? "on" : undefined}
              onClick={() => onLens(item.key)}
            >
              {item.title}
            </button>
          ))}
        </div>
        <div className="replay-phone-dock">
          <button
            type="button"
            aria-pressed={sheet === "setup"}
            className={sheet === "setup" ? "on" : undefined}
            onClick={() => toggle("setup")}
          >
            {setupLabel}
          </button>
          {showFleet ? (
            <button
              type="button"
              aria-pressed={sheet === "fleet"}
              className={sheet === "fleet" ? "on" : undefined}
              onClick={() => toggle("fleet")}
            >
              {fleetLabel}
            </button>
          ) : null}
        </div>
      </div>
    </>
  )
}
