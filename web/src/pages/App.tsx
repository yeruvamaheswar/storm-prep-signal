import { useEffect, useState } from "react"
import type { RunFile } from "../contracts"
import { OperatorWall } from "../components/templates/OperatorWall"
import { FleetApp } from "../features/fleet/FleetApp"
import { FlowApp } from "../features/flow/FlowApp"
import { FleetGridApp, LiveApp, ReplayApp } from "../features/shell/ShellPages"
import { loadRun } from "../loadRun"
import { isFleetPath, isFlowPath, isLivePath, isReplayPath, isWallPath } from "./route"

function WallApp() {
  const [run, setRun] = useState<RunFile | null>(null)

  useEffect(() => {
    let cancelled = false
    loadRun().then((next) => {
      if (!cancelled) {
        setRun(next)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (run === null) {
    return <p className="loading">Reading run</p>
  }

  return <OperatorWall run={run} />
}

export function App() {
  if (isLivePath(window.location.pathname)) {
    return <LiveApp />
  }
  if (window.location.pathname.replace(/\/+$/, "") === "/fleet/table") {
    return <FleetApp />
  }
  if (isFleetPath(window.location.pathname)) {
    return <FleetGridApp />
  }
  if (isFlowPath(window.location.pathname)) {
    return <FlowApp />
  }
  if (isWallPath(window.location.pathname)) {
    return <WallApp />
  }
  if (isReplayPath(window.location.pathname)) {
    return <ReplayApp />
  }
  return <ReplayApp />
}
