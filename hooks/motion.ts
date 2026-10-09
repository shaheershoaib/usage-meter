// A gauge moves from where it was to where it is now, in a short ease-out. The motion is
// drawn by redrawing the cells in quick bursts, and only while something is moving: when
// every gauge is still, nothing redraws at all.
export const SWEEP_MS = 700
export const SWEEP_TICK_MS = 55

type Move = { from: number; to: number; at: number }
const anim = new Map<string, Move>()
const ease = (k: number) => 1 - (1 - k) ** 3
const valueOf = (a: Move, now: number) => a.from + (a.to - a.from) * ease(Math.min(1, (now - a.at) / SWEEP_MS))

// What a gauge shows at `now`: its first appearance fills from empty, a new value eases from
// wherever the gauge is at that moment, and an unchanged value stands still.
export const shownOf = (key: string, percent: number | null, now: number): number | null => {
  if (percent === null) {
    anim.delete(key)

    return null
  }
  let a = anim.get(key)
  if (!a) {
    a = { from: 0, to: percent, at: now }
    anim.set(key, a)
  } else if (a.to !== percent) {
    a = { from: valueOf(a, now), to: percent, at: now }
    anim.set(key, a)
  }

  return valueOf(a, now)
}

export const isSweeping = (now: number) => [...anim.values()].some(a => now - a.at < SWEEP_MS)

export const isMoving = (key: string, now: number) => {
  const a = anim.get(key)

  return a !== undefined && now - a.at < SWEEP_MS
}
