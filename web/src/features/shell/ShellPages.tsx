import { TopBar } from "./TopBar"
import { ReplayRoot } from "../replay/ReplayRoot"
import { FleetGridRoot } from "../fleetgrid/FleetGridRoot"
import { LiveRoot } from "../live/LiveRoot"

export function ReplayApp() {
  return <ReplayRoot />
}

export function LiveApp() {
  return <LiveRoot />
}

export function FleetGridApp() {
  return (
    <div className="rg-shell is-clay">
      <TopBar current="fleet" />
      <FleetGridRoot />
    </div>
  )
}
