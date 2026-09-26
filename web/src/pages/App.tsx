import { useEffect, useState } from "react"
import type { RunFile } from "../contracts"
import { OperatorWall } from "../components/templates/OperatorWall"
import { FleetApp } from "../features/fleet/FleetApp"
import { loadRun } from "../loadRun"
import { isFleetPath } from "./route"

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
  if (isFleetPath(window.location.pathname)) {
    return <FleetApp />
  }
  return <WallApp />
}
