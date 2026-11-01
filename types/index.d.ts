export type Limit = { label: string; pct: number; resetsAt?: number }

export type Snap = {
  ctx?: number
  limits: Limit[]
}

// week: the billing week (the seven-day limit's window); null off a
// subscription, absent in a value stored before it was added.
export type Spend = { day: number; week?: number | null; month: number; unpriced: string[] }

declare module 'claude-code' {
  interface PluginState {
    'usage-band': { snap: Snap | null; spend: Spend | null; now: number }
  }
}
