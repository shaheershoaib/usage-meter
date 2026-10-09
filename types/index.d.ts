export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
// Dollars, as the usage card shows them (the API sends minor units).
export type Credits = { isEnabled: boolean; spent: number; limit: number; percentUsed: number; currency: string }

declare module 'claude-code' {
  interface PluginState {
    'usage-meter': { windows: Limit[]; credits: Credits | null; error: string | null }
  }
}
