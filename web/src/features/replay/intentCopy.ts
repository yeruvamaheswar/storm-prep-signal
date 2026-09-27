/** What the fleet was ordered to do this tick, in plain words. The engine stamps `intent` and
 * `intent_reason` (server/engine/controller.py `acted_intent`); this only names them, it never
 * re-derives them. Shared by the promise panel and the ledger so both read the same. */

const VERBS: Record<string, string> = {
  charge: "Charge",
  discharge: "Sell",
  hold: "Hold",
}

const REASONS: Record<string, string> = {
  // controller.acted_intent: charged more than it sold, and sold something. Not "the call was met": on
  // storm-rule-high tick 30 it sold 0.009 of a 0.144 MW call. So it says toward, never served.
  grid_call_served: "sold toward the call, then charged",
  reserve_refill: "refilled batteries under their floor",
  grid_call: "sold for the grid call",
  zone_price: "charged on a cheap zone price",
  // controller.acted_intent: the DAM rule (policy.dam_charge) set a charging zone.
  dam_cheap_hour: "charged in its zone's cheapest day-ahead hours",
  rt_dip: "charged on a real-time dip below the day-ahead plan",
  // controller.dam_wait_reason: nothing moved, every zone held by the DAM rule.
  cheaper_hour_later: "waiting for a cheaper day-ahead hour",
  no_payback: "no later day-ahead hour pays back a charge",
  no_grid_call: "no call",
  operator_hold: "operator hold",
}

function words(code: string): string {
  return code.replace(/_/g, " ")
}

/** "Fleet did: Charge, refilled batteries under their floor". An empty reason gives the verb only;
 * an unknown code reads as the code in words; no intent gives no line (null). */
export function intentLine(intent: string | null | undefined, reason: string | null | undefined): string | null {
  if (!intent) return null
  const plain = words(intent)
  const verb = VERBS[intent] ?? plain.charAt(0).toUpperCase() + plain.slice(1)
  const why = reason ? REASONS[reason] ?? words(reason) : ""
  // A comma, not a dash: the copy rule allows no em dashes (global-constraints.md).
  return why ? `Fleet did: ${verb}, ${why}` : `Fleet did: ${verb}`
}
