/** What the fleet was ordered to do this tick, in plain words. The engine stamps `intent` and
 * `intent_reason` (server/engine/controller.py `acted_intent`); this only names them, it never
 * re-derives them. Shared by the promise panel and the ledger so both read the same. */

const VERBS: Record<string, string> = {
  charge: "Charge",
  discharge: "Sell",
  hold: "Hold",
}

const REASONS: Record<string, string> = {
  grid_call_served: "served the call, then charged",
  reserve_refill: "refilled batteries under their floor",
  grid_call: "sold for the grid call",
  zone_price: "charged on a cheap zone price",
  no_grid_call: "no call",
  operator_hold: "operator hold",
}

function words(code: string): string {
  return code.replace(/_/g, " ")
}

/** "Fleet did: Charge — refilled batteries under their floor". An empty reason gives the verb only;
 * an unknown code reads as the code in words; no intent gives no line (null). */
export function intentLine(intent: string | null | undefined, reason: string | null | undefined): string | null {
  if (!intent) return null
  const plain = words(intent)
  const verb = VERBS[intent] ?? plain.charAt(0).toUpperCase() + plain.slice(1)
  const why = reason ? REASONS[reason] ?? words(reason) : ""
  return why ? `Fleet did: ${verb} — ${why}` : `Fleet did: ${verb}`
}
