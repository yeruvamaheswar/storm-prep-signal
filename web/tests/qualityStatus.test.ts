import { describe, expect, it } from "vitest"
import { qualityStatus } from "../src/qualityStatus"

describe("quality status", () => {
  it("turns a passed check into Live", () => {
    expect(qualityStatus("ok", "LIVE", false)).toEqual({
      status: "live",
      label: "Live",
      reason: "check passed",
      tone: "ok",
      tooltip: "The latest ERCOT outage posting passed the check.",
    })
  })

  it("maps a live auth failure to Auth error, not the raw code", () => {
    const status = qualityStatus("auth", "LIVE", false)
    expect(status.status).toBe("auth_error")
    expect(status.label).toBe("Auth error")
    expect(status.reason).toBe("ERCOT login failed")
    expect(status.tone).toBe("dead")
    expect(status.label).not.toBe("auth")
    expect(status.reason).not.toBe("named fail")
  })

  it("maps stale and a timeout to Stale and Degraded", () => {
    expect(qualityStatus("stale", "TAPE", false)).toMatchObject({
      status: "stale",
      label: "Stale",
      reason: "reading is old",
      tone: "stale",
    })
    expect(qualityStatus("timeout", "TAPE", false)).toMatchObject({
      status: "degraded",
      label: "Degraded",
      reason: "report timed out",
      tone: "reserved",
    })
    expect(qualityStatus("signal_unavailable", "TAPE", false)).toMatchObject({
      status: "degraded",
      label: "Degraded",
      reason: "signal could not be read",
      tone: "reserved",
    })
  })

  it("maps fixture overlay failures on the synthetic tape to Demo data", () => {
    for (const code of ["auth", "timeout", "stale", "malformed", "unavailable"]) {
      const status = qualityStatus(code, "SYNTHETIC", true)
      expect(status).toMatchObject({
        status: "demo",
        label: "Demo data",
        reason: "layout fixture",
        tone: "stale",
      })
      expect(status.label).not.toBe(code)
    }
  })

  it("keeps a staged synthetic timeout as Degraded when the clock is not pinned", () => {
    expect(qualityStatus("timeout", "SYNTHETIC", false)).toMatchObject({
      status: "degraded",
      label: "Degraded",
      reason: "report timed out",
    })
  })

  it("labels the pinned synthetic tape as Demo data before a live check", () => {
    expect(qualityStatus("unchecked", "SYNTHETIC", true)).toMatchObject({
      status: "demo",
      label: "Demo data",
      reason: "layout fixture",
      tone: "stale",
    })
  })

  it("keeps a feed failure as feed health when the wall is Live", () => {
    expect(qualityStatus("auth", "SYNTHETIC", true, "live")).toMatchObject({
      status: "auth_error",
      label: "Auth error",
      reason: "ERCOT login failed",
    })
    expect(qualityStatus("unchecked", "SYNTHETIC", true, "live")).toMatchObject({
      status: "degraded",
      label: "Degraded",
    })
    expect(qualityStatus("timeout", "LIVE", false, "live").label).toBe("Degraded")
    expect(qualityStatus("signal_unavailable", "SYNTHETIC", true, "live")).toMatchObject({
      status: "degraded",
      label: "Degraded",
      reason: "signal could not be read",
    })
    expect(qualityStatus("stale", "SYNTHETIC", true, "live")).toMatchObject({
      status: "stale",
      label: "Stale",
    })
    for (const code of ["ok", "auth", "stale", "timeout", "unchecked", "malformed"]) {
      const status = qualityStatus(code, "SYNTHETIC", true, "live")
      expect(status.label).toMatch(/^(Live|Stale|Auth error|Degraded)$/)
      expect(status.reason).not.toMatch(/layout fixture|Demo data/)
    }
  })
})
