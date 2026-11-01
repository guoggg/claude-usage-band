import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'usage-band',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const NOW = Date.UTC(2026, 9, 25, 12, 0)
const HOUR = 3_600_000

const SCAN = { exitCode: 0, stdout: '{"day":12.5,"week":85.4,"month":300.25,"unpriced":[]}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

const usage = (usd: number) => ({
  startedAt: NOW,
  context: { window: 200_000, tokens: 76_000, percent: 38 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 3, resetsAt: new Date(NOW + 4 * HOUR + 22 * 60_000).toISOString() },
    { kind: 'seven_day', percentUsed: 25, resetsAt: new Date(NOW + 113 * HOUR).toISOString() },
  ],
  cost: { usd },
})

test('one line: context against the compact window, windows, scanned cost', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const runs: string[][] = []
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    return { value: SCAN }
  })
  // An auto-compact window of 152k: 76k tokens read as 50%, not the full window's 38%.
  on('session.usage', (_, e) => ({
    value: e.breakdown
      ? ({ ...usage(1), context: { ...usage(1).context, breakdown: { rawMaxTokens: 152_000 } } } as never)
      : usage(1),
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure({ ...usage(3.5), changed: ['cost'] })
  await clock.settle()

  const term = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const line = await term.find({ type: 'Text', text: /ctx/ })
  expect(line?.text).toBe('◑ 50% ctx · ○ 3% 5h · 4h22m · ◔ 25% 7d · 4d17h · $12.50/D · $85/W · $300/M')
  await term.unmount()

  const desk = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await desk.find({ type: 'Text', text: /4h22m/ }))?.text).toBe('4h22m')
  expect((await desk.find({ type: 'Text', text: /4d17h/ }))?.text).toBe('4d17h')
  expect((await desk.find({ type: 'Text', text: /\/D$/ }))?.text).toBe('$12.50/D')
  expect((await desk.find({ type: 'Text', text: /\/W/ }))?.text).toBe('· $85/W · $300/M')
  expect(await desk.find({ type: 'Svg' })).toBeTruthy()
  await desk.unmount()

  // The billing week starts seven days before the seven-day window resets.
  const weekStart = (NOW + 113 * HOUR - 7 * 24 * HOUR) / 1000
  expect(runs[0]?.slice(-2)).toEqual(['--week-start', String(weekStart)])
})

test('yields to a survey', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('process.run', () => ({ value: SCAN }))
  on('session.usage', () => ({ value: usage(1) }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, hasSurvey: true } })
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})

test('colors follow the usage popover thresholds: calm green, then warning at 75%, critical at 90%', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('process.run', () => ({ value: SCAN }))
  const u = usage(1)
  const hot = {
    ...u,
    rateLimits: [
      { ...u.rateLimits[0], percentUsed: 92 },
      { ...u.rateLimits[1], percentUsed: 86 },
    ],
  }
  on('session.usage', () => ({ value: hot }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const desk = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await desk.find({ type: 'Text', text: '38%' }))?.props.color).toBeUndefined()
  expect((await desk.find({ type: 'Text', text: '86%' }))?.props.color).toBe('warning')
  expect((await desk.find({ type: 'Text', text: '92%' }))?.props.color).toBe('error')
  const rings = (await desk.findAll({ type: 'Svg' })).map(r => String(r.props.source))
  expect(rings[0]).toContain('rgba(88,166,104,0.75)')
  expect(rings[1]).toContain('#d03b3b')
  expect(rings[2]).toContain('#fab219')
  await desk.unmount()
})
