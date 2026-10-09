import type { Credits, Limit } from '../types'

// How often the usage card may ask Anthropic, shared by every open session so five
// sessions make one request, not five, and how long to wait once it says "slow down".
export const FRESH_MS = 60_000
// The server answers 429 with retry-after 0 ("try again now"), so the first wait is short.
const BACKOFF_FIRST_MS = 30_000
const BACKOFF_MAX_MS = 5 * 60_000

export type Cached = { at: number; windows: Limit[]; credits: Credits | null }
export type Block = { until: number; ms: number }

export const asCached = (value: unknown): Cached | undefined => {
  const v = value as Partial<Cached> | null | undefined

  return v && typeof v.at === 'number' && Array.isArray(v.windows) ? (v as Cached) : undefined
}

export const asBlock = (value: unknown): Block | undefined => {
  const v = value as Partial<Block> | null | undefined

  return v && typeof v.until === 'number' && typeof v.ms === 'number' ? (v as Block) : undefined
}

// What to do now: use what another session already read, wait out a rate limit, or ask.
export const decide = (now: number, cached: Cached | undefined, block: Block | undefined): 'adopt' | 'wait' | 'ask' => {
  if (block && now < block.until) {
    return 'wait'
  }

  return cached && now - cached.at < FRESH_MS ? 'adopt' : 'ask'
}

// A 429's new wait: what the server asked for (`retry-after`, in seconds), else 30 s and then twice the last, up to 5 min.
export const backoff = (now: number, before: Block | undefined, retryAfter: string | undefined): Block => {
  const asked = Number(retryAfter)
  const ms =
    Number.isFinite(asked) && asked > 0
      ? Math.min(BACKOFF_MAX_MS, asked * 1000)
      : Math.min(BACKOFF_MAX_MS, before ? before.ms * 2 : BACKOFF_FIRST_MS)

  return { until: now + ms, ms }
}

export const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000))
