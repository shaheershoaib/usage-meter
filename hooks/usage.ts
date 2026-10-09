import type { Credits, Limit } from '../types'

// The reply of GET /api/oauth/usage, the endpoint behind the app's usage card.
type Window = { utilization?: number | null; resets_at?: string | null } | null | undefined
type Reply = {
  five_hour?: Window
  seven_day?: Window
  extra_usage?: {
    is_enabled: boolean
    monthly_limit?: number | null
    used_credits?: number | null
    utilization?: number | null
    currency?: string | null
  } | null
}

const tenth = (value: number) => Math.round(value * 10) / 10

const windowOf = (kind: string, raw: Window): Limit[] =>
  raw && typeof raw.utilization === 'number'
    ? [{ kind, percentUsed: tenth(raw.utilization), ...(raw.resets_at ? { resetsAt: raw.resets_at } : {}) }]
    : []

export const parseUsage = (text: string): { windows: Limit[]; credits: Credits | null } => {
  const reply = JSON.parse(text) as Reply
  const extra = reply.extra_usage
  let credits: Credits | null = null
  if (extra) {
    // Amounts are minor units of the currency, cents for USD.
    const limit = (extra.monthly_limit ?? 0) / 100
    const spent = (extra.used_credits ?? 0) / 100
    credits = {
      isEnabled: extra.is_enabled,
      spent,
      limit,
      percentUsed: tenth(limit > 0 ? (spent / limit) * 100 : (extra.utilization ?? 0)),
      currency: extra.currency ?? 'USD',
    }
  }

  return { windows: [...windowOf('five_hour', reply.five_hour), ...windowOf('seven_day', reply.seven_day)], credits }
}

const SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£' }

export const money = (amount: number, currency: string) =>
  `${SYMBOLS[currency] ?? `${currency} `}${String(Math.round(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
