import { TopBar } from "./TopBar"

function ReplaySlot() {
  return (
    <>
      <span>Scenario</span>
      <span className="rg-pill">Network chaos</span>
      <span>Tick 1 of 4</span>
    </>
  )
}

function LiveSlot() {
  return (
    <span className="rg-pill">
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <circle cx="5" cy="5" r="4" fill="#2F8A55" />
      </svg>
      Live from ERCOT, updated 2 min ago
    </span>
  )
}

type PlaceholderProps = {
  title: string
  children: string
}

function Placeholder({ title, children }: PlaceholderProps) {
  return (
    <main className="rg-stage">
      <section className="rg-placeholder" aria-labelledby="page-title">
        <h1 id="page-title">{title}</h1>
        <p>{children}</p>
      </section>
    </main>
  )
}

export function ReplayApp() {
  return (
    <div className="rg-shell">
      <TopBar current="replay" rightSlot={<ReplaySlot />} />
      <Placeholder title="Replay">The replay map, tick tape, scenarios, and drill-in panels will be here.</Placeholder>
    </div>
  )
}

export function LiveApp() {
  return (
    <div className="rg-shell">
      <TopBar current="live" rightSlot={<LiveSlot />} />
      <Placeholder title="Live">The live ERCOT inputs, newest tick, and replay handoff will be here.</Placeholder>
    </div>
  )
}

export function FleetGridApp() {
  return (
    <div className="rg-shell is-clay">
      <TopBar current="fleet" />
      <Placeholder title="Fleet">The fleet grid, zone districts, filters, and home detail panel will be here.</Placeholder>
    </div>
  )
}
