import { BatteryCell } from "./BatteryCell"
import { matchesFilter, type FilterKey, type ZoneBank } from "./fleetModel"

type BankPanelProps = {
  bank: ZoneBank
  filter: FilterKey
  focused: boolean
  selectedId: string | null
  foundId: string | null
  onSelect: (id: string) => void
}

/** One zone "battery bank": its name, a short note and its cells, five across. */
export function BankPanel({ bank, filter, focused, selectedId, foundId, onSelect }: BankPanelProps) {
  const label = bank.zone === null ? bank.name : `${bank.name} zone`
  return (
    <section className={focused ? "fg-bank is-focus" : "fg-bank"} aria-label={label} data-zone={bank.key}>
      <div className="fg-bank-head">
        <h2>{bank.name}</h2>
        <span>{bank.homes.length ? bank.note : "No homes"}</span>
      </div>
      {bank.homes.length === 0 ? null : <div className="fg-dist">
        {bank.homes.map((h) => (
          <BatteryCell
            key={h.id}
            home={h}
            dim={!matchesFilter(h, filter)}
            selected={selectedId === h.id}
            found={foundId === h.id}
            onSelect={onSelect}
          />
        ))}
      </div>}
    </section>
  )
}
