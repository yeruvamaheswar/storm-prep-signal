import { describe, expect, it, vi } from "vitest"
import {
  hrefForUrlState,
  readUrlState,
  subscribeUrlState,
  writeUrlState,
  zoomToHome,
  zoomToZone,
} from "../src/features/shell/urlState"

function target(search = "?scenario=storm&tick=2") {
  return {
    history: {
      pushState: vi.fn(),
      replaceState: vi.fn(),
    },
    location: {
      pathname: "/",
      search,
    },
  }
}

describe("shell url state", () => {
  it("reads scenario, zone, home, and tick from the query string", () => {
    expect(readUrlState("?scenario=chaos&zone=North&home=home-058&tick=3")).toEqual({
      scenario: "chaos",
      zone: "North",
      home: "home-058",
      tick: 3,
    })
    expect(readUrlState("?tick=nope")).toMatchObject({ tick: null })
  })

  it("writes only present fields", () => {
    expect(
      hrefForUrlState("/", {
        scenario: "chaos",
        zone: null,
        home: null,
        tick: 1,
      }),
    ).toBe("/?scenario=chaos&tick=1")
  })

  it("replaces normal state writes and pushes zoom-ins", () => {
    const fake = target()
    expect(
      writeUrlState(
        {
          scenario: "storm",
          zone: null,
          home: null,
          tick: 4,
        },
        { target: fake },
      ),
    ).toBe("/?scenario=storm&tick=4")
    expect(fake.history.replaceState).toHaveBeenCalledOnce()

    expect(zoomToZone("Houston", fake)).toBe("/?scenario=storm&zone=Houston&tick=2")
    expect(zoomToHome("home-012", fake)).toBe("/?scenario=storm&home=home-012&tick=2")
    expect(fake.history.pushState).toHaveBeenCalledTimes(2)
  })

  it("does not push a history entry when zoom is already current", () => {
    const zone = target("?scenario=storm&zone=Houston&tick=2")
    expect(zoomToZone("Houston", zone)).toBe("/?scenario=storm&zone=Houston&tick=2")
    expect(zone.history.pushState).not.toHaveBeenCalled()
    expect(zone.history.replaceState).not.toHaveBeenCalled()

    const home = target("?scenario=storm&zone=Houston&home=home-012&tick=2")
    expect(zoomToHome("home-012", home)).toBe("/?scenario=storm&zone=Houston&home=home-012&tick=2")
    expect(home.history.pushState).not.toHaveBeenCalled()
    expect(home.history.replaceState).not.toHaveBeenCalled()
  })

  it("notifies listeners when browser history pops", () => {
    const seen: Array<ReturnType<typeof readUrlState>> = []
    window.history.replaceState(null, "", "/?scenario=chaos&zone=North&tick=2")
    const unsubscribe = subscribeUrlState((state) => seen.push(state))
    window.dispatchEvent(new PopStateEvent("popstate"))
    unsubscribe()
    expect(seen).toEqual([{ scenario: "chaos", zone: "North", home: null, tick: 2 }])
  })
})
