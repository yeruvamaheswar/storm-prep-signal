# Worker acks on the wall

The ack row under the map is a count per load zone: how many homes answered, are held for backup, are silent, are dead, or never confirmed.

Those numbers come from the last engine tick. We do not talk to real batteries yet. A home that got work and answered is acked. A live home that got no work is held. Stale is silent. Dead is dead. If both the send and the one retry are dropped, that home is unconfirmed.

The row is four stacked bars, one per zone. It is not one tick per home.

More detail: `docs/agents/zone-acks.md`.
