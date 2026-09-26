import type {
  Ack,
  Attention,
  AttentionChoice,
  AttentionInput,
  CalmStreak,
  Fleet,
  Home,
  HomeCommand,
  HomeStatus,
  Mode,
  Playback,
  Price,
  Quality,
  Reserve,
  ReserveReason,
  SkipReason,
  Stress,
  StressLevel,
  Tape,
  Target,
  Tick,
  TickSource,
  Zone,
} from "./types"

const QUALITIES = [
  "ok",
  "timeout",
  "http",
  "bad_payload",
  "missing_field",
  "impossible_value",
  "stale",
] as const satisfies readonly Quality[]

const MODES = ["AUTO", "HOLD", "RESERVE"] as const satisfies readonly Mode[]

const TICK_SOURCES = ["live", "playback"] as const satisfies readonly TickSource[]

const RESERVE_REASONS = [
  "normal",
  "stress_high",
  "signal_untrusted",
  "operator_hold",
  "command_rejected",
] as const satisfies readonly ReserveReason[]

const STRESS_LEVELS = ["LOW", "HIGH"] as const satisfies readonly StressLevel[]

const ATTENTION_INPUTS = ["target", "price", "stress"] as const satisfies readonly AttentionInput[]

const ATTENTION_CHOICES = ["approve", "retry", "skip"] as const satisfies readonly AttentionChoice[]

const HOME_STATUSES = ["live", "stale", "dead", "unconfirmed"] as const satisfies readonly HomeStatus[]

const ACKS = ["ok", "rejected", "timeout"] as const satisfies readonly Ack[]

const SKIP_REASONS = [
  "below_floor",
  "stale",
  "dead",
  "unconfirmed",
  "hold",
  "reserve",
] as const satisfies readonly SkipReason[]

const MISSED_TOLERANCE_MW = 0.001

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected ${label}`)
  }
  return value as Record<string, unknown>
}

function readString(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing ${key}`)
  }
  return value
}

function readNullableString(value: unknown, label: string): string | null {
  if (value === null) return null
  if (typeof value === "string" && value.length > 0) return value
  throw new Error(`missing ${label}`)
}

function readNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key]
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`missing ${key}`)
  }
  return value
}

function readBoolean(row: Record<string, unknown>, key: string): boolean {
  const value = row[key]
  if (typeof value !== "boolean") {
    throw new Error(`missing ${key}`)
  }
  return value
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T
  }
  throw new Error(`unknown ${label}`)
}

function readFeedSource(value: unknown): string {
  if (value === "ercot" || value === "utility") return value
  if (typeof value === "string" && /^tape:.+/.test(value)) return value
  throw new Error("unknown source")
}

function readQuality(value: unknown): Quality {
  return readEnum(value, QUALITIES, "quality")
}

function readTarget(value: unknown): Target {
  const row = readRecord(value, "target")
  return {
    mw: readNumber(row, "mw"),
    source: readFeedSource(row.source),
    as_of: readString(row, "as_of"),
    quality: readQuality(row.quality),
  }
}

function readPrice(value: unknown): Price {
  const row = readRecord(value, "price")
  return {
    usd_mwh: readNumber(row, "usd_mwh"),
    source: readFeedSource(row.source),
    as_of: readString(row, "as_of"),
    quality: readQuality(row.quality),
  }
}

function readReserve(value: unknown): Reserve {
  const row = readRecord(value, "reserve")
  return {
    pct: readNumber(row, "pct"),
    reason: readEnum(row.reason, RESERVE_REASONS, "reserve reason"),
    sellable_mwh: readNumber(row, "sellable_mwh"),
    held_mwh: readNumber(row, "held_mwh"),
  }
}

function readCalmStreak(value: unknown): CalmStreak {
  if (value === 0 || value === 1 || value === 2) return value
  throw new Error("unknown calm_streak")
}

function readStressLevel(value: unknown): StressLevel | null {
  if (value === null) return null
  return readEnum(value, STRESS_LEVELS, "stress level")
}

function readStress(value: unknown): Stress {
  const row = readRecord(value, "stress")
  return {
    outage_mw: readNumber(row, "outage_mw"),
    threshold_mw: readNumber(row, "threshold_mw"),
    margin_mw: readNumber(row, "margin_mw"),
    zone_id: readString(row, "zone_id"),
    level: readStressLevel(row.level),
    as_of: readString(row, "as_of"),
    quality: readQuality(row.quality),
    calm_streak: readCalmStreak(row.calm_streak),
  }
}

export function parseFleet(value: unknown): Fleet {
  const row = readRecord(value, "fleet")
  if (!Object.prototype.hasOwnProperty.call(row, "breaches")) {
    throw new Error("missing breaches")
  }
  return {
    live: readNumber(row, "live"),
    stale: readNumber(row, "stale"),
    dead: readNumber(row, "dead"),
    unconfirmed: readNumber(row, "unconfirmed"),
    breaches: readNumber(row, "breaches"),
  }
}

function readFleet(value: unknown): Fleet {
  return parseFleet(value)
}

function readReasons(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("missing reasons")
  }
  return value as string[]
}

function readChoices(value: unknown): AttentionChoice[] {
  if (!Array.isArray(value)) throw new Error("missing choices")
  return value.map((item) => readEnum(item, ATTENTION_CHOICES, "choice"))
}

export function parseAttention(value: unknown): Attention {
  const row = readRecord(value, "attention")
  return {
    attention_id: readString(row, "attention_id"),
    reason: readString(row, "reason"),
    input: readEnum(row.input, ATTENTION_INPUTS, "attention input"),
    prompt: readString(row, "prompt"),
    choices: readChoices(row.choices),
    retry_spent: readBoolean(row, "retry_spent"),
  }
}

function readAttention(value: unknown): Attention | null {
  if (value === null) return null
  return parseAttention(value)
}

export function parseZone(value: unknown): Zone {
  const row = readRecord(value, "zone")
  return {
    zone_id: readString(row, "zone_id"),
    zone_name: readString(row, "zone_name"),
    reserve_pct_normal: readNumber(row, "reserve_pct_normal"),
    reserve_pct_stressed: readNumber(row, "reserve_pct_stressed"),
    stress_threshold_mw: readNumber(row, "stress_threshold_mw"),
    stress_margin_mw: readNumber(row, "stress_margin_mw"),
    tick_minutes: readNumber(row, "tick_minutes"),
  }
}

export function parseTick(value: unknown): Tick {
  const row = readRecord(value, "tick")
  const source = readEnum(row.source, TICK_SOURCES, "source")
  const tapeId = readNullableString(row.tape_id, "tape_id")
  if (source === "playback" && tapeId === null) {
    throw new Error("missing tape_id")
  }
  if (source === "live" && tapeId !== null) {
    throw new Error("unknown tape_id")
  }
  const target = readTarget(row.target)
  const deliveredMw = readNumber(row, "delivered_mw")
  const missedMw = readNumber(row, "missed_mw")
  // missed_mw is target minus delivered. Reject a tick that drifts past the tolerance.
  if (Math.abs(missedMw - (target.mw - deliveredMw)) > MISSED_TOLERANCE_MW) {
    throw new Error("missed_mw is not target.mw - delivered_mw")
  }
  return {
    tick_id: readString(row, "tick_id"),
    ts: readString(row, "ts"),
    source,
    tape_id: tapeId,
    mode: readEnum(row.mode, MODES, "mode"),
    target,
    price: readPrice(row.price),
    delivered_mw: deliveredMw,
    missed_mw: missedMw,
    reserve: readReserve(row.reserve),
    stress: readStress(row.stress),
    fleet: readFleet(row.fleet),
    quality: readQuality(row.quality),
    reasons: readReasons(row.reasons),
    brief: readString(row, "brief"),
    attention: readAttention(row.attention),
  }
}

function readAck(value: unknown): Ack | null {
  if (value === null) return null
  return readEnum(value, ACKS, "ack")
}

function readCommand(value: unknown): HomeCommand | null {
  if (value === null) return null
  const row = readRecord(value, "last_command")
  return {
    kw: readNumber(row, "kw"),
    sent_at: readString(row, "sent_at"),
    ack: readAck(row.ack),
  }
}

function readSkipReason(value: unknown): SkipReason | null {
  if (value === null) return null
  return readEnum(value, SKIP_REASONS, "skip_reason")
}

export function parseHome(value: unknown): Home {
  const row = readRecord(value, "home")
  return {
    home_id: readString(row, "home_id"),
    status: readEnum(row.status, HOME_STATUSES, "status"),
    capacity_kwh: readNumber(row, "capacity_kwh"),
    soc_kwh: readNumber(row, "soc_kwh"),
    floor_kwh: readNumber(row, "floor_kwh"),
    max_kw: readNumber(row, "max_kw"),
    assigned_kw: readNumber(row, "assigned_kw"),
    eligible: readBoolean(row, "eligible"),
    skip_reason: readSkipReason(row.skip_reason),
    last_seen: readString(row, "last_seen"),
    last_command: readCommand(row.last_command),
  }
}

export function parseTape(value: unknown): Tape {
  const row = readRecord(value, "tape")
  return {
    tape_id: readString(row, "tape_id"),
    title: readString(row, "title"),
    ticks: readNumber(row, "ticks"),
    labeled: readString(row, "labeled"),
  }
}

export function parsePlayback(value: unknown): Playback | null {
  if (value === null) return null
  const row = readRecord(value, "playback")
  return {
    tape_id: readString(row, "tape_id"),
    tick_index: readNumber(row, "tick_index"),
    tick_count: readNumber(row, "tick_count"),
  }
}
