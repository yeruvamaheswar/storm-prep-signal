import { useEffect, useState } from "react"
import type { RunFile } from "../contracts"
import { OperatorWall } from "../components/templates/OperatorWall"
import { loadRun } from "../loadRun"

export function App() {
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
