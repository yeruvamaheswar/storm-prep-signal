type FleetLegendProps = {
  floorText: string
}

/** "How to read a battery" row, from mockup/Fleet.dc.html. */
export function FleetLegend({ floorText }: FleetLegendProps) {
  const swatch = (color: string) => (
    <svg width="14" height="14" aria-hidden="true"><rect width="14" height="14" rx="3" fill={color} /></svg>
  )
  return (
    <section className="fg-legend" aria-label="How to read a battery">
      <p className="fg-lbl">How to read a battery</p>
      <span className="fg-lgi">{swatch("var(--rg-confirmed)")}Charge above its floor</span>
      <span className="fg-lgi">{swatch("var(--rg-order-way)")}Selling to the grid</span>
      <span className="fg-lgi">{swatch("var(--rg-charging)")}Charging</span>
      <span className="fg-lgi">{swatch("var(--rg-fleet-under)")}Under its floor, holding</span>
      <span className="fg-lgi">{swatch("var(--rg-fleet-reserved)")}Reserved for backup</span>
      <span className="fg-lgi">{swatch("var(--rg-islanded)")}Islanded: backing up its own home</span>
      <span className="fg-lgi">
        <svg width="22" height="6" aria-hidden="true"><line x1="0" y1="3" x2="22" y2="3" stroke="var(--rg-ink)" strokeWidth="1.6" strokeDasharray="3 2" /></svg>
        {floorText}
      </span>
      <span className="fg-lgi">{swatch("var(--rg-fleet-off-shell)")}Offline</span>
      <span className="fg-lgi">
        <svg width="14" height="14" aria-hidden="true"><rect x="1" y="1" width="12" height="12" rx="3" fill="none" stroke="var(--rg-fleet-stale-edge)" strokeWidth="1.5" strokeDasharray="3 2" /></svg>
        No reading
      </span>
    </section>
  )
}
