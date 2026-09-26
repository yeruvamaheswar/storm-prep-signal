import type { Attention, AttentionChoice } from "./types"

// The plan's choices. Retry is offered once; after retry_spent it is gone.
const OPEN: readonly AttentionChoice[] = ["approve", "retry", "skip"]
const SPENT: readonly AttentionChoice[] = ["approve", "skip"]

export function remainingChoices(attention: Attention): AttentionChoice[] {
  const choices = attention.retry_spent ? SPENT : OPEN
  return [...choices]
}
