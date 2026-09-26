import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"
import "@fontsource/ibm-plex-sans/400.css"
import "@fontsource/ibm-plex-sans/500.css"
import "@fontsource/ibm-plex-sans/600.css"
import "../../design/tokens.css"
import { FleetPage } from "./FleetPage"
import { HomePage } from "./HomePage"
import { previewHomes } from "./preview-data"
import type { Home, StatusFilter } from "./types"

function homesFor(filter: StatusFilter): Home[] {
  switch (filter) {
    case "all":
      return previewHomes
    case "live":
    case "stale":
    case "dead":
    case "unconfirmed":
      return previewHomes.filter((home) => home.status === filter)
    default: {
      const unexpected: never = filter
      return unexpected
    }
  }
}

function FleetPreview() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [openHomeId, setOpenHomeId] = useState<string | null>(null)
  const openHome = previewHomes.find((home) => home.home_id === openHomeId) ?? null

  if (openHome !== null) {
    return <HomePage home={openHome} onBack={() => setOpenHomeId(null)} />
  }

  return (
    <FleetPage
      homes={homesFor(statusFilter)}
      statusFilter={statusFilter}
      onFilter={setStatusFilter}
      onOpenHome={setOpenHomeId}
    />
  )
}

const root = document.getElementById("root")
if (root === null) {
  throw new Error("missing root")
}

createRoot(root).render(
  <StrictMode>
    <FleetPreview />
  </StrictMode>,
)
