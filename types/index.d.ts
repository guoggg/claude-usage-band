export type Limit = { label: string; pct: number; resetsAt?: number }

export type Snap = {
  ctx?: number
  limits: Limit[]
}

// five / week: the five-hour and seven-day limits' windows; null off a
// subscription, absent in a value stored before they were added.
export type Spend = { day: number; five?: number | null; week?: number | null; month: number; unpriced: string[] }

declare module 'claude-code' {
  interface PluginState {
    'usage-band': { snap: Snap | null; spend: Spend | null; now: number }
  }
}
