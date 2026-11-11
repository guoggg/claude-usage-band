import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register, SessionMeasureInput } from 'claude-code'

import type { Limit, Snap, Spend } from '../types'

const snap = atom({ plugin: 'usage-band', key: 'snap' } as const, null)
const spend = atom({ plugin: 'usage-band', key: 'spend' } as const, null)
const now = atom({ plugin: 'usage-band', key: 'now' } as const, 0)

const pad = (n: number) => String(n).padStart(2, '0')

const label = (kind: string) =>
  kind
    .replace(/^five_hour/, '5h')
    .replace(/^seven_day/, '7d')
    .replace(/^spend_limit$/, 'spend')
    .replace(/_/g, ' ')

const left = (ms: number) => {
  const m = Math.max(0, Math.floor(ms / 60_000))
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  if (d > 0) return `${d}d${h}h`
  if (h > 0) return `${h}h${pad(m % 60)}m`
  return `${m}m`
}

// The app's own usage popover: normal below 75%, warning from 75%, critical
// from 90%. Undefined while normal: the text stays muted and the ring keeps
// the accent arc.
const WARN_PCT = 75
const CRITICAL_PCT = 90
const tone = (pct: number): Color | undefined =>
  pct >= CRITICAL_PCT ? 'error' : pct >= WARN_PCT ? 'warning' : undefined

const usd = (n: number) => `$${n.toFixed(2)}`
// A limit window's spend, beside its percentage: one decimal below $100.
const windowUsd = (n: number) => (n < 100 ? `$${n.toFixed(1)}` : `$${Math.round(n)}`)

// The context percentage is measured against the auto-compact window, as
// /context and the session rail do, not the model's full window. The window
// comes from a local breakdown estimate (no API call), asked again when the
// model's window changes or every WINDOW_TTL_MS in case the setting moved.
const WINDOW_TTL_MS = 10 * 60_000
let compact: { model: number; raw: number; at: number } | null = null

async function compactWindow($: EngineInterface, model: number) {
  const t = await $.clock.now()
  if (compact && compact.model === model && t - compact.at < WINDOW_TTL_MS) return compact.raw
  try {
    const { context } = await $.session.usage({ breakdown: 'summary' })
    const raw = context.breakdown?.rawMaxTokens
    if (raw) compact = { model, raw, at: t }
  } catch (err) {
    $.ui.log(`usage-band: no context breakdown: ${String(err)}`, { to: 'debug' })
  }
  return compact?.raw ?? model
}

async function contextPercent($: EngineInterface, c: SessionMeasureInput['context']) {
  if (c.tokens === undefined) return c.percent
  const raw = await compactWindow($, c.window)
  return Math.round((c.tokens / raw) * 100)
}

async function measure($: EngineInterface, e: Pick<SessionMeasureInput, 'context' | 'rateLimits'>) {
  const limits: Limit[] = e.rateLimits.map(r => ({
    label: label(r.kind),
    pct: r.percentUsed,
    resetsAt: r.resetsAt ? Date.parse(r.resetsAt) : undefined,
  }))
  const next: Snap = { ctx: await contextPercent($, e.context), limits }
  const at = await $.clock.now()
  await update($, snap, () => next)
  await update($, now, () => at)
}

// Day, five-hour-window, billing-week and month cost come from
// scripts/scan.py, which prices every transcript under ~/.claude/projects; at
// most one scan at a time, spaced by MIN_GAP_MS unless a limit window moved.
const MIN_GAP_MS = 60_000
const PERIOD_MS = 5 * 60_000
const FIVE_MS = 5 * 3_600_000
const WEEK_MS = 7 * 86_400_000
let scanning = false
let lastScan = 0
let lastWindows = ''

// Each window starts its length before its reset: the limits' own windows,
// not calendar periods.
async function windowStart($: EngineInterface, label: string, length: number) {
  const reset = (await read($, snap))?.limits.find(l => l.label === label)?.resetsAt
  return reset === undefined ? undefined : reset - length
}

async function scan($: EngineInterface, force = false) {
  const t = await $.clock.now()
  const week = await windowStart($, '7d', WEEK_MS)
  const five = await windowStart($, '5h', FIVE_MS)
  const windows = `${week}/${five}`
  if (windows !== lastWindows) force = true
  if (scanning || (!force && t - lastScan < MIN_GAP_MS)) return
  scanning = true
  lastScan = t
  lastWindows = windows
  try {
    const script = `${$.plugin.root}/scripts/scan.py`
    const args = [
      ...(week === undefined ? [] : ['--week-start', String(week / 1000)]),
      ...(five === undefined ? [] : ['--five-start', String(five / 1000)]),
    ]
    const { exitCode, stdout, stderr } = await $.process.run(['/usr/bin/python3', '-I', script, ...args], {
      cwd: $.plugin.root,
      timeoutMs: 120_000,
    })
    if (exitCode !== 0) {
      $.ui.log(`usage-band scan failed: ${stderr.slice(0, 500)}`, { to: 'debug' })
      return
    }
    const out = JSON.parse(stdout) as Spend
    await update($, spend, () => ({ day: out.day, five: out.five, week: out.week, month: out.month, unpriced: out.unpriced }))
  } catch (err) {
    $.ui.log(`usage-band scan failed: ${String(err)}`, { to: 'debug' })
  } finally {
    scanning = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await measure($, await $.session.usage())
    void scan($, true)
    // Keep the reset countdowns moving, and the spend fresh, between turns.
    $.clock.every(60_000, async () => {
      const t = await $.clock.now()
      await update($, now, () => t)
      if (t - lastScan >= PERIOD_MS) await scan($)
    })
    return result
  })

  on('session.measure', async ($, e, next) => {
    await measure($, e)
    void scan($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snap)
    if (e.props.hasSurvey || s === null) return next(e)

    const segs = segments(s, await read($, spend), await read($, now))

    if (e.surface === 'terminal') {
      const { Box, Text } = $.ui.resolve(e)
      const sep = <Text dimColor> · </Text>
      const parts = segs.map(g => (
        <Text>
          <Text color={g.color}>
            {g.pct !== undefined ? `${pie(g.pct)} ` : ''}
            {g.value}
          </Text>
          {g.spend ? <Text dimColor> {g.spend}</Text> : null}
          <Text dimColor> {g.label}</Text>
        </Text>
      ))
      return (
        <Box flexDirection="row" flexWrap="nowrap" overflow="hidden">
          <Text wrap="truncate-end">{parts.flatMap((p, i) => (i === 0 ? [p] : [sep, p]))}</Text>
        </Box>
      )
    }

    // Progress on the left, each with its ring; spend pushed to the right
    // edge, ringless since it measures no fraction.
    const { Box, Text, Svg } = $.ui.resolve(e)
    const item = (g: Segment) => (
      <Box flexDirection="row" flexShrink={0} alignItems="center" columnGap="xs">
        {g.glyph === 'cost' ? null : (
          <Svg source={ring(g.pct, g.glyph, g.color)} alt={`${g.value} ${g.label}`} width={RING_PX} height={RING_PX} />
        )}
        <Text size="body" tabular weight="medium" color={g.color} dimColor={!g.color}>
          {g.value}
        </Text>
        {g.spend ? (
          <Text size="footnote" tabular dimColor>
            {g.spend}
          </Text>
        ) : null}
        <Text size="footnote" tabular dimColor wrap="truncate-end">
          {g.ringLabel ?? g.label}
        </Text>
      </Box>
    )
    const progress = segs.filter(g => g.glyph !== 'cost')
    const cost = segs.filter(g => g.glyph === 'cost')
    return (
      <Box flexDirection="row" flexWrap="nowrap" overflow="hidden" alignItems="center" justifyContent="space-between" columnGap="md">
        <Box flexDirection="row" flexWrap="nowrap" overflow="hidden" alignItems="center" columnGap="md">
          {progress.map(item)}
        </Box>
        {cost.map(item)}
      </Box>
    )
  })
}

type Glyph = 'ctx' | 'five' | 'week' | 'spark' | 'cost'

// ringLabel: the desktop's label where the ring already names the window
// (5 for the five-hour, w for the seven-day), leaving the countdown alone.
// spend: the limit window's cost, drawn dim between the percentage and the
// countdown.
type Segment = {
  glyph: Glyph
  pct?: number
  value: string
  spend?: string
  label: string
  ringLabel?: string
  color?: Color
}

function segments(s: Snap, p: Spend | null, t: number): Segment[] {
  const out: Segment[] = []
  if (s.ctx !== undefined) {
    out.push({ glyph: 'ctx', pct: s.ctx, value: `${s.ctx}%`, label: 'ctx', color: tone(s.ctx) })
  }
  for (const l of s.limits) {
    const glyph: Glyph = l.label === '5h' ? 'five' : l.label === '7d' ? 'week' : 'spark'
    const countdown = l.resetsAt !== undefined && t ? left(l.resetsAt - t) : ''
    const label = countdown ? `${l.label} · ${countdown}` : l.label
    const ringLabel = glyph === 'spark' ? undefined : countdown
    const cost = glyph === 'five' ? p?.five : glyph === 'week' ? p?.week : undefined
    const spend = cost === null || cost === undefined ? undefined : windowUsd(cost)
    out.push({ glyph, pct: l.pct, value: `${l.pct}%`, spend, label, ringLabel, color: tone(l.pct) })
  }
  if (p) {
    const mark = p.unpriced.length ? '*' : ''
    out.push({ glyph: 'cost', value: `${usd(p.day)}/D`, label: `· $${Math.round(p.month)}/M${mark}` })
  }
  return out
}

// Terminal stand-in for a ring: a quarter-step pie glyph.
const pie = (pct: number) => ['○', '◔', '◑', '◕', '●'][Math.min(4, Math.round(pct / 25))]

// The Svg is drawn as an image, so theme keys don't reach it: concrete colors.
// Mid-gray reads on light and dark alike; the arc keeps a quiet green until
// the popover's thresholds turn it to its bar fills (--cds-fill-warning /
// -danger): amber, then red.
const NEUTRAL = '#8e8e93'
const TRACK = 'rgba(142,142,147,0.22)'
const ARC: Record<string, string> = { warning: '#fab219', error: '#d03b3b' }
const CALM_ARC = 'rgba(88,166,104,0.75)'
const RING_PX = 20

const letter = (ch: string, y: number, size: number) => (c: string) =>
  `<text x="10" y="${y}" text-anchor="middle" font-family="-apple-system,system-ui,sans-serif" ` +
  `font-size="${size}" font-weight="600" fill="${c}">${ch}</text>`

const GLYPH: Record<Glyph, (c: string) => string> = {
  ctx: c => `<circle cx="10" cy="10" r="2.2" fill="${c}"/>`,
  // Baselines set so the figure's cap height, and the w's x-height, center.
  five: letter('5', 13.3, 9.5),
  week: letter('w', 12.7, 10),
  spark: c => `<path d="M10 6L11 9L14 10L11 11L10 14L9 11L6 10L9 9Z" fill="${c}"/>`,
  cost: letter('$', 13.3, 9),
}

function ring(pct: number | undefined, glyph: Glyph, color?: Color) {
  const arcColor = (color && ARC[color]) ?? CALM_ARC
  const glyphColor = (color && ARC[color]) ?? NEUTRAL
  const r = 8
  const len = 2 * Math.PI * r
  const arc = pct === undefined ? 0 : (Math.max(0, Math.min(100, pct)) / 100) * len
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="20" height="20">` +
    `<circle cx="10" cy="10" r="${r}" fill="none" stroke="${TRACK}" stroke-width="1.8"/>` +
    (arc > 0
      ? `<circle cx="10" cy="10" r="${r}" fill="none" stroke="${arcColor}" stroke-width="1.8" stroke-linecap="round" ` +
        `stroke-dasharray="${arc.toFixed(2)} ${len.toFixed(2)}" transform="rotate(-90 10 10)"/>`
      : '') +
    GLYPH[glyph](glyphColor) +
    `</svg>`
  )
}
