// A gauge made of colored cells. Boxes and text update in place when the UI
// redraws, where a picture would be reloaded: nothing here can flicker.
export type Level = { accent: string; from: string; to: string; isLow: boolean }

export const BAR_CELLS = 22
const TRACK = '#2b303b'

export const levelOf = (percent: number): Level => {
  if (percent >= 100) {
    return { accent: '#f87171', from: '#fca5a5', to: '#dc2626', isLow: true }
  }
  if (percent >= 80) {
    return { accent: '#fb923c', from: '#fdba74', to: '#ef4444', isLow: true }
  }
  if (percent >= 60) {
    return { accent: '#fbbf24', from: '#fde68a', to: '#f59e0b', isLow: false }
  }

  return { accent: '#34d399', from: '#6ee7b7', to: '#22d3ee', isLow: false }
}

const part = (c: string, at: number) => parseInt(c.slice(at, at + 2), 16)
const two = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0')
const mix = (a: string, b: string, k: number) =>
  `#${two(part(a, 1) * (1 - k) + part(b, 1) * k)}${two(part(a, 3) * (1 - k) + part(b, 3) * k)}${two(part(a, 5) * (1 - k) + part(b, 5) * k)}`

// The color of each cell. Filled cells shade along the bar; the cell where the fill ends is
// blended by how much of it is covered, so the edge slides smoothly instead of jumping a cell
// at a time; and while the bar is moving (`glow`) its leading edge shines.
export const barColors = (percent: number | null, level: Level, glow: boolean): string[] => {
  const filled = (Math.min(100, Math.max(0, percent ?? 0)) / 100) * BAR_CELLS

  return Array.from({ length: BAR_CELLS }, (_, i) => {
    const shaded = mix(level.from, level.to, i / (BAR_CELLS - 1))
    let color = TRACK
    if (percent !== null) {
      if (i + 1 <= filled) {
        color = shaded
      } else if (i < filled) {
        color = mix(TRACK, shaded, filled - i)
      }
      if (glow && i < filled) {
        const behind = filled - i
        color = behind <= 1.5 ? mix(color, '#ffffff', 0.5) : behind <= 3 ? mix(color, '#ffffff', 0.18) : color
      }
    }

    return color
  })
}

// Neighbours of one color share a box, so a bar is a handful of boxes, not twenty-two.
export const runsOf = (colors: string[]): { color: string; n: number }[] => {
  const runs: { color: string; n: number }[] = []
  for (const color of colors) {
    const last = runs[runs.length - 1]
    if (last && last.color === color) {
      last.n += 1
    } else {
      runs.push({ color, n: 1 })
    }
  }

  return runs
}
