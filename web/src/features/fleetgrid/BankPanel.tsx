import { BatteryCell } from "./BatteryCell"
import { bankTitle, countyAria, countyTitle, matchesFilter, type FilterKey, type GridHome, type ZoneBank } from "./fleetModel"

type BankPanelProps = {
  bank: ZoneBank
  filter: FilterKey
  focused: boolean
  selectedId: string | null
  foundId: string | null
  onSelect: (id: string) => void
  /** Task 13 item 7: this region is shown split into its county blocks. */
  split?: boolean
  onSplit?: (zone: string) => void
}

type CellsProps = Pick<BankPanelProps, "filter" | "selectedId" | "foundId" | "onSelect"> & { homes: GridHome[] }

function Cells({ homes, filter, selectedId, foundId, onSelect }: CellsProps) {
  return (
    <div className="fg-dist">
      {homes.map((h) => (
        <BatteryCell
          key={h.id}
          home={h}
          dim={!matchesFilter(h, filter)}
          selected={selectedId === h.id}
          found={foundId === h.id}
          onSelect={onSelect}
        />
      ))}
    </div>
  )
}

/** One region "battery bank": its title, a short note and its cells, five across; optionally split by county. */
export function BankPanel({ bank, filter, focused, selectedId, foundId, onSelect, split = false, onSplit }: BankPanelProps) {
  const label = bank.zone === null ? bank.name : `${bank.name} zone`
  const canSplit = bank.homes.length > 0 && bank.counties.some((c) => c.fips !== null)
  const cells = { filter, selectedId, foundId, onSelect }
  const countiesId = `fg-counties-${bank.key}`
  let body = null
  if (bank.homes.length && split && canSplit) {
    body = (
      <div className="fg-counties" id={countiesId}>
        {bank.counties.map((c) => (
          <section key={c.key} className="fg-county" aria-label={countyAria(c, bank)}>
            <h3>{countyTitle(c)}</h3>
            {c.homes.length ? <Cells homes={c.homes} {...cells} /> : null}
          </section>
        ))}
      </div>
    )
  } else if (bank.homes.length) {
    body = <div id={countiesId}><Cells homes={bank.homes} {...cells} /></div>
  }
  return (
    <section className={focused ? "fg-bank is-focus" : "fg-bank"} aria-label={label} data-zone={bank.key}>
      <div className="fg-bank-head">
        <h2>{bankTitle(bank)}</h2>
        {canSplit ? (
          <button
            type="button"
            className={split ? "fg-split on" : "fg-split"}
            aria-pressed={split}
            aria-controls={countiesId}
            onClick={() => onSplit?.(bank.key)}
          >
            Split by county
          </button>
        ) : null}
      </div>
      <p className="fg-bank-note">{bank.homes.length ? bank.note : "No homes"}</p>
      {body}
    </section>
  )
}
