import type { Ack, HomeStatus, SkipReason, StatusFilter } from "./types"

export const STATUS_FILTERS: StatusFilter[] = [
  "all",
  "live",
  "stale",
  "dead",
  "unconfirmed",
]

export function quantity(value: number): string {
  return value.toFixed(1)
}

export function formatSeen(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return iso
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "America/Chicago",
    timeZoneName: "short",
  }).format(date)
}

export function filterText(status: StatusFilter): string {
  switch (status) {
    case "all":
      return "all"
    case "live":
    case "stale":
    case "dead":
    case "unconfirmed":
      return status
    default: {
      const unexpected: never = status
      return unexpected
    }
  }
}

export function ackText(ack: Ack): string {
  switch (ack) {
    case "ok":
    case "rejected":
    case "timeout":
      return ack
    case null:
      return "none"
    default: {
      const unexpected: never = ack
      return unexpected
    }
  }
}

export function ackClass(ack: Ack): string {
  switch (ack) {
    case "ok":
      return "fleet-tone-ok"
    case "rejected":
      return "fleet-tone-dead"
    case "timeout":
      return "fleet-tone-warn"
    case null:
      return "fleet-tone-muted"
    default: {
      const unexpected: never = ack
      return unexpected
    }
  }
}

export function statusClass(status: HomeStatus): string {
  switch (status) {
    case "live":
      return "fleet-tone-ok"
    case "stale":
      return "fleet-tone-stale"
    case "dead":
      return "fleet-tone-dead"
    case "unconfirmed":
      return "fleet-tone-warn"
    default: {
      const unexpected: never = status
      return unexpected
    }
  }
}

export function skipText(reason: SkipReason): string {
  switch (reason) {
    case "below_floor":
    case "stale":
    case "dead":
    case "unconfirmed":
    case "hold":
    case "reserve":
      return reason
    case null:
      return "none"
    default: {
      const unexpected: never = reason
      return unexpected
    }
  }
}

export function skipClass(reason: SkipReason): string {
  switch (reason) {
    case "below_floor":
    case "hold":
    case "reserve":
    case "unconfirmed":
      return "fleet-tone-warn"
    case "stale":
      return "fleet-tone-stale"
    case "dead":
      return "fleet-tone-dead"
    case null:
      return "fleet-tone-muted"
    default: {
      const unexpected: never = reason
      return unexpected
    }
  }
}

export function chargeClass(socKwh: number, floorKwh: number): string {
  if (socKwh < floorKwh) {
    return "fleet-tone-warn"
  }
  return "fleet-tone-ink"
}
