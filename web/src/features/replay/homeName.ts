/**
 * One name per home on every screen (Task 17): the engine's `Zone-County-Number`, e.g.
 * `Houston-FortBend-005`. Pure. Only visible and aria text use it; `data-home` and `?home=` keep the raw id.
 */

/** Any row that names a home: scenario `homes[]`, GET /v1/homes, or a Fleet grid home. */
export type NameableHome = {
  id?: string
  home_id?: string
  name?: string | null
  zone?: string | null
  /** County FIPS. Read by nothing here: the name needs the county's name. */
  county?: string | null
  county_name?: string | null
  countyName?: string | null
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null
}

/**
 * The engine's `name` when present. Otherwise the same format as server/engine/fleet.py `home_label`:
 * `{zone}-{county name without spaces}-{the id's last "-" part}`. With no zone or county name, the raw id
 * (a bare FIPS is not what the engine prints for a roster county). Never a new format.
 */
export function homeName(home: NameableHome): string {
  const id = text(home.id) ?? text(home.home_id) ?? ""
  const name = text(home.name)
  if (name) return name
  const zone = text(home.zone)
  const county = text(home.county_name) ?? text(home.countyName)
  if (!zone || !county || !id) return id
  return `${zone}-${county.split(" ").join("")}-${id.slice(id.lastIndexOf("-") + 1)}`
}

/** The name of the home with this id in `homes`, or the raw id when the list does not report it. */
export function homeNameById(homes: readonly NameableHome[] | undefined, id: string): string {
  const home = homes?.find((row) => (text(row.id) ?? text(row.home_id)) === id)
  return home ? homeName(home) : id
}
