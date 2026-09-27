import type { Lens } from "../replay/ScenarioRail"

type Props = {
  lens: Lens
  onLens: (lens: Lens) => void
}

// The same three lenses and words as Replay's rail (ScenarioRail), which Live cannot mount without its scenario list.
const LENSES: Array<{ key: Lens; title: string; body: string }> = [
  { key: "send", title: "Send", body: "Where the orders went" },
  { key: "keep", title: "Keep", body: "What protected each home's backup" },
  { key: "trust", title: "Trust", body: "Which homes answered, and honestly" },
]

export function LiveLens({ lens, onLens }: Props) {
  return (
    <section className="replay-panel replay-lens" aria-label="Lens">
      <p className="replay-label">What to show</p>
      <div>
        {LENSES.map((item) => (
          <button key={item.key} type="button" aria-pressed={lens === item.key} className={lens === item.key ? "on" : undefined} onClick={() => onLens(item.key)}>
            <b>{item.title}</b>
            <span>{item.body}</span>
          </button>
        ))}
      </div>
    </section>
  )
}
