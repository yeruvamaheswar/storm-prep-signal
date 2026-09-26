import type { CSSProperties, ReactNode } from "react"
import {
  ageMinutes,
  earliestIso,
  formatClock,
  formatCount,
  formatMw,
  formatProvenance,
  formatSignedMw,
  formatUsd,
} from "./format"
import type {
  Attention,
  AttentionChoice,
  HomeStatus,
  Mode,
  Tick,
  WallHome,
  WallPageProps,
} from "./types"

type Tone = "ink" | "ok" | "reserved" | "dead" | "stale"

type FigureProps = {
  label: string
  value: string
  unit: string
  tone?: Tone
  source?: string
  asOf?: string
  quality?: string
  detail?: string
}

export function WallPage({
  zone,
  tick,
  recentTicks,
  homes,
  onMode,
  onAttention,
  onOpenHome,
}: WallPageProps) {
  const oldest = earliestIso([tick.target.as_of, tick.price.as_of, tick.stress.as_of])
  const oldestAge = ageMinutes(oldest, tick.ts)
  const reportAge = ageMinutes(tick.stress.as_of, tick.ts)
  const playback = tick.source === "playback"
  const measured = measuredSource(tick)

  return (
    <div className="wall-page" data-mode={tick.mode} data-source={tick.source} data-quality={tick.quality}>
      <header className="wall-mast">
        <h1 className="wall-title">{zone.zone_name}</h1>
        <p className="wall-mast-meta">
          <span className={playback ? "wall-tone-reserved" : undefined}>{feedLabel(tick.source)}</span>
          {tick.tape_id !== null ? <span>{`tape:${tick.tape_id}`}</span> : null}
          <span className={modeClass(tick.mode)}>{tick.mode}</span>
          <span>{stopName(tick.mode)}</span>
          <span>{formatClock(tick.ts)}</span>
        </p>
      </header>

      <Region title="Money">
        <div className="wall-figures">
          <Figure
            label="Target"
            value={formatMw(tick.target.mw)}
            unit="MW"
            tone={tick.target.quality === "ok" ? "ink" : "dead"}
            source={tick.target.source}
            asOf={tick.target.as_of}
            quality={tick.target.quality}
          />
          <Figure
            label="Delivered"
            value={formatMw(tick.delivered_mw)}
            unit="MW"
            tone={deliveredTone(tick)}
            source={measured}
            asOf={tick.ts}
          />
          <Figure
            label="Missed"
            value={formatMw(tick.missed_mw)}
            unit="MW"
            tone={tick.missed_mw > 0 ? "reserved" : "ink"}
            source={measured}
            asOf={tick.ts}
          />
          <Figure
            label="Price"
            value={formatUsd(tick.price.usd_mwh)}
            unit="$/MWh"
            tone={tick.price.quality === "ok" ? "ink" : "dead"}
            source={tick.price.source}
            asOf={tick.price.as_of}
            quality={tick.price.quality}
          />
        </div>
      </Region>

      <Region title="Safety">
        <p className={`wall-stop ${modeClass(tick.mode)}`}>{stopSentence(tick.mode)}</p>
        <div className="wall-figures">
          <Figure
            label="Reserve"
            value={formatCount(tick.reserve.pct)}
            unit="%"
            tone={tick.reserve.pct > zone.reserve_pct_normal ? "reserved" : "ink"}
            detail={tick.reserve.reason}
          />
          <Figure label="Sellable" value={formatMw(tick.reserve.sellable_mwh)} unit="MWh" />
          <Figure label="Held" value={formatMw(tick.reserve.held_mwh)} unit="MWh" />
          <Figure
            label="Breaches"
            value={formatCount(tick.fleet.breaches)}
            unit="homes"
            tone={tick.fleet.breaches === 0 ? "ok" : "dead"}
            detail="Homes under their floor"
          />
        </div>
        <p className="wall-policy">{policyLine(zone)}</p>
      </Region>

      <Region title="Stress">
        <div className="wall-figures">
          <Figure
            label="Outage"
            value={formatMw(tick.stress.outage_mw)}
            unit="MW"
            tone={tick.stress.level === "HIGH" ? "reserved" : "ink"}
            source="ercot"
            asOf={tick.stress.as_of}
            quality={tick.stress.quality}
          />
          <Figure
            label="Threshold"
            value={formatMw(tick.stress.threshold_mw)}
            unit="MW"
            source="ercot"
            asOf={tick.stress.as_of}
            quality={tick.stress.quality}
          />
          <Figure
            label="Signed margin"
            value={formatSignedMw(tick.stress.margin_mw)}
            unit="MW"
            tone={tick.stress.margin_mw > 0 ? "reserved" : "ink"}
            source="ercot"
            asOf={tick.stress.as_of}
            quality={tick.stress.quality}
            detail={marginDetail(tick.stress.margin_mw)}
          />
          <Figure
            label="Driving zone"
            value={tick.stress.zone_id}
            unit=""
            detail={tick.stress.zone_id === zone.zone_id ? zone.zone_name : "Other zone"}
          />
          <Figure label="Level" value={levelText(tick.stress.level)} unit="" tone={levelTone(tick.stress.level)} />
          <Figure
            label="Calm streak"
            value={String(tick.stress.calm_streak)}
            unit="of 2"
            tone={streakTone(tick.stress.calm_streak)}
            detail="Normal floor needs 2"
          />
          <Figure
            label="Report age"
            value={reportAge === null ? "—" : formatCount(reportAge)}
            unit={reportAge === null ? "" : "min"}
            detail={formatClock(tick.stress.as_of)}
          />
        </div>
      </Region>

      <Region title="Quality">
        <div className="wall-figures">
          <Figure label="Tick" value={tick.quality} unit="" tone={tick.quality === "ok" ? "ok" : "dead"} />
          <Figure
            label="Oldest input"
            value={oldestAge === null ? "—" : formatCount(oldestAge)}
            unit={oldestAge === null ? "" : "min"}
            detail={formatClock(oldest)}
          />
        </div>
      </Region>

      <Region title="Fleet">
        <ul className="wall-counts">
          <li className="wall-tone-ok">
            <strong>{formatCount(tick.fleet.live)}</strong> live
          </li>
          <li className="wall-tone-stale">
            <strong>{formatCount(tick.fleet.stale)}</strong> stale
          </li>
          <li className="wall-tone-dead">
            <strong>{formatCount(tick.fleet.dead)}</strong> dead
          </li>
          <li className="wall-tone-ink">
            <strong>{formatCount(tick.fleet.unconfirmed)}</strong> unconfirmed
          </li>
        </ul>
        <div className="wall-squares">
          {homes.map((home) => (
            <HomeSquare key={home.home_id} home={home} onOpenHome={onOpenHome} />
          ))}
        </div>
      </Region>

      <Region title="Brief">
        <p className="wall-brief">{tick.brief}</p>
      </Region>

      <Region title="Reasons">
        {tick.reasons.length === 0 ? (
          <p className="wall-note">None</p>
        ) : (
          <ul className="wall-reasons">
            {tick.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
      </Region>

      {tick.attention === null ? null : (
        <AttentionBanner attention={tick.attention} onAttention={onAttention} />
      )}

      <Region title="Mode">
        <div className="wall-actions">
          <button
            type="button"
            className={tick.mode === "HOLD" ? "wall-button wall-button-pressed" : "wall-button"}
            aria-pressed={tick.mode === "HOLD"}
            disabled={playback}
            onClick={() => onMode("HOLD")}
          >
            Hold
          </button>
          <button
            type="button"
            className={tick.mode === "AUTO" ? "wall-button wall-button-pressed" : "wall-button"}
            aria-pressed={tick.mode === "AUTO"}
            disabled={playback}
            onClick={() => onMode("AUTO")}
          >
            Auto
          </button>
        </div>
        <p className="wall-note">
          {playback
            ? "Hold and Auto are off during playback."
            : "Hold and Auto are sent for the next tick."}
        </p>
      </Region>

      <Region title="Recent ticks">
        <p className="wall-note">Target MW on top. Delivered MW under it.</p>
        {recentTicks.length === 0 ? (
          <p className="wall-note">No ticks yet.</p>
        ) : (
          <ol className="wall-strip">
            {recentTicks.map((item, index) => (
              <li key={item.tick_id} className="wall-strip-item">
                <span className="wall-strip-name">{index === recentTicks.length - 1 ? "Now" : item.tick_id}</span>
                <span className="wall-strip-bar" aria-hidden="true">
                  <span
                    className="wall-strip-fill"
                    style={fillStyle(item.target_mw, item.delivered_mw)}
                  />
                </span>
                <span className="wall-strip-nums">
                  <span className="wall-tone-ink">{formatMw(item.target_mw)}</span>
                  <span className={item.delivered_mw <= 0 && item.target_mw > 0 ? "wall-tone-reserved" : "wall-tone-ok"}>
                    {formatMw(item.delivered_mw)}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </Region>
    </div>
  )
}

function Region({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="wall-region" aria-label={title}>
      <h2 className="wall-key">{title}</h2>
      {children}
    </section>
  )
}

function Figure({ label, value, unit, tone = "ink", source, asOf, quality, detail }: FigureProps) {
  return (
    <div className="wall-figure">
      <span className="wall-key">{label}</span>
      <p className={`wall-value wall-tone-${tone}`}>
        {value}
        {unit === "" ? null : <span className="wall-unit">{unit}</span>}
      </p>
      {source !== undefined && asOf !== undefined ? (
        <p className="wall-stamp">{formatProvenance(source, asOf, quality)}</p>
      ) : null}
      {detail !== undefined ? <p className="wall-stamp">{detail}</p> : null}
    </div>
  )
}

function AttentionBanner({
  attention,
  onAttention,
}: {
  attention: Attention
  onAttention: (choice: AttentionChoice) => void
}) {
  const limitId = `wall-attention-${attention.attention_id}`
  return (
    <section className="wall-region" aria-label="Attention">
      <h2 className="wall-key">Attention</h2>
      <p className="wall-prompt">{attention.prompt}</p>
      <p className="wall-stamp">{`${attention.input} · ${attention.reason} · ${attention.attention_id}`}</p>
      <p id={limitId} className="wall-limit">
        Selling does not resume from these actions.
      </p>
      <div className="wall-actions">
        {visibleChoices(attention).map((choice) => (
          <button
            key={choice}
            type="button"
            className="wall-button"
            aria-describedby={limitId}
            onClick={() => onAttention(choice)}
          >
            {choiceLabel(choice)}
          </button>
        ))}
      </div>
    </section>
  )
}

function HomeSquare({ home, onOpenHome }: { home: WallHome; onOpenHome: (homeId: string) => void }) {
  return (
    <button
      type="button"
      className={squareClass(home.status)}
      title={`${home.home_id} ${home.status}`}
      aria-label={`${home.home_id}, ${home.status}`}
      onClick={() => onOpenHome(home.home_id)}
    />
  )
}

function visibleChoices(attention: Attention): AttentionChoice[] {
  const seen = new Set<AttentionChoice>()
  const visible: AttentionChoice[] = []
  for (const choice of attention.choices) {
    if (choice === "retry" && attention.retry_spent) continue
    if (seen.has(choice)) continue
    seen.add(choice)
    visible.push(choice)
  }
  return visible
}

function choiceLabel(choice: AttentionChoice): string {
  switch (choice) {
    case "approve":
      return "Approve"
    case "retry":
      return "Retry once"
    case "skip":
      return "Skip"
    default: {
      const neverChoice: never = choice
      return neverChoice
    }
  }
}

function measuredSource(tick: Tick): string {
  switch (tick.source) {
    case "live":
      return "live"
    case "playback":
      return tick.tape_id === null ? "playback" : `tape:${tick.tape_id}`
    default: {
      const neverSource: never = tick.source
      return neverSource
    }
  }
}

function feedLabel(source: Tick["source"]): string {
  switch (source) {
    case "live":
      return "LIVE"
    case "playback":
      return "PLAYBACK"
    default: {
      const neverSource: never = source
      return neverSource
    }
  }
}

function stopName(mode: Mode): string {
  switch (mode) {
    case "AUTO":
      return "Selling"
    case "HOLD":
      return "Operator stop"
    case "RESERVE":
      return "Safety stop"
    default: {
      const neverMode: never = mode
      return neverMode
    }
  }
}

function stopSentence(mode: Mode): string {
  switch (mode) {
    case "AUTO":
      return "AUTO is selling above the floor."
    case "HOLD":
      return "HOLD is the operator stop. Discharge is stopped."
    case "RESERVE":
      return "RESERVE is the safety stop. Discharge is stopped."
    default: {
      const neverMode: never = mode
      return neverMode
    }
  }
}

function modeClass(mode: Mode): string {
  switch (mode) {
    case "AUTO":
      return "wall-tone-ok"
    case "HOLD":
      return "wall-tone-reserved"
    case "RESERVE":
      return "wall-tone-reserved"
    default: {
      const neverMode: never = mode
      return neverMode
    }
  }
}

function deliveredTone(tick: Tick): Tone {
  if (tick.delivered_mw > 0) return "ok"
  if (tick.mode === "HOLD" || tick.mode === "RESERVE") return "reserved"
  return "ink"
}

function marginDetail(margin: number): string {
  if (margin > 0) return "Above the line"
  if (margin < 0) return "Under the line"
  return "On the line"
}

function levelText(level: Tick["stress"]["level"]): string {
  switch (level) {
    case "LOW":
      return "LOW"
    case "HIGH":
      return "HIGH"
    case null:
      return "Untrusted"
    default: {
      const neverLevel: never = level
      return neverLevel
    }
  }
}

function levelTone(level: Tick["stress"]["level"]): Tone {
  switch (level) {
    case "LOW":
      return "ok"
    case "HIGH":
      return "reserved"
    case null:
      return "dead"
    default: {
      const neverLevel: never = level
      return neverLevel
    }
  }
}

function streakTone(streak: 0 | 1 | 2): Tone {
  switch (streak) {
    case 0:
      return "reserved"
    case 1:
      return "ink"
    case 2:
      return "ok"
    default: {
      const neverStreak: never = streak
      return neverStreak
    }
  }
}

function squareClass(status: HomeStatus): string {
  switch (status) {
    case "live":
      return "wall-square wall-square-live"
    case "stale":
      return "wall-square wall-square-stale"
    case "dead":
      return "wall-square wall-square-dead"
    case "unconfirmed":
      return "wall-square wall-square-unconfirmed"
    default: {
      const neverStatus: never = status
      return neverStatus
    }
  }
}

function policyLine(zone: WallPageProps["zone"]): string {
  return `Normal floor ${formatCount(zone.reserve_pct_normal)}% · Stressed floor ${formatCount(zone.reserve_pct_stressed)}% · Threshold ${formatMw(zone.stress_threshold_mw)} MW · Band ${formatMw(zone.stress_margin_mw)} MW · Every ${formatCount(zone.tick_minutes)} min`
}

function fillPercent(targetMw: number, deliveredMw: number): number {
  if (targetMw <= 0) return 0
  const pct = (deliveredMw / targetMw) * 100
  if (pct < 0) return 0
  if (pct > 100) return 100
  return pct
}

function fillStyle(targetMw: number, deliveredMw: number): CSSProperties {
  return { "--wall-fill": `${fillPercent(targetMw, deliveredMw)}%` } as CSSProperties
}
