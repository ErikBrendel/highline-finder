import { describe, expect, it } from 'vitest'
import { standingGround, windowsFor } from './terrain.js'
import { Grid } from '../shared/grid.js'

const TILE = 256
const windowOf = (e: number, n: number) => `${Math.floor(e / TILE)}_${Math.floor(n / TILE)}`

describe('windowsFor', () => {
  it('covers every point along the line', () => {
    const a = { e: 400_000, n: 5_785_000 }
    const b = { e: 402_700, n: 5_787_900 }
    const keys = new Set(windowsFor(a, b).map(([tx, ty]) => `${tx}_${ty}`))
    for (let i = 0; i <= 400; i++) {
      const t = i / 400
      expect(keys).toContain(windowOf(a.e + (b.e - a.e) * t, a.n + (b.n - a.n) * t))
    }
  })

  it('asks for a band along a diagonal rather than its bounding box', () => {
    const a = { e: 400_000, n: 5_785_000 }
    const b = { e: 402_800, n: 5_787_800 }
    const side = Math.ceil(2800 / TILE) + 3
    expect(windowsFor(a, b).length).toBeLessThan((side * side) / 2)
  })

  it('covers a single point and its neighbours, for dragging', () => {
    const a = { e: 400_100, n: 5_785_100 }
    expect(windowsFor(a, a)).toHaveLength(9)
  })

  it('spends the margin in metres rather than rounding it up to whole windows', () => {
    const a = { e: 400_100, n: 5_785_100 }
    const b = { e: 400_600, n: 5_785_400 }
    // A 20 m band round a 580 m line touches four windows here. Rounded up to a window it was a
    // ring of neighbours round every step, which is what made the overlay light up ground the line
    // comes nowhere near.
    expect(windowsFor(a, b, 20).length).toBeLessThan(windowsFor(a, b).length / 2)
    // Monotone in the margin, with no step at a window boundary: asking for less never costs more.
    const sizes = [1, 20, 60, 150, 256].map((m) => windowsFor(a, b, m).length)
    expect(sizes).toEqual([...sizes].sort((x, y) => x - y))
  })

  it('still covers the whole band it was asked for, not just the centreline', () => {
    const a = { e: 400_100, n: 5_785_100 }
    const b = { e: 402_700, n: 5_786_400 }
    const margin = 30
    const keys = new Set(windowsFor(a, b, margin).map(([tx, ty]) => `${tx}_${ty}`))
    const len = Math.hypot(b.e - a.e, b.n - a.n)
    const [dx, dy] = [(b.e - a.e) / len, (b.n - a.n) / len]
    for (let i = 0; i <= 2000; i++) {
      const t = i / 2000
      const [e, n] = [a.e + (b.e - a.e) * t, a.n + (b.n - a.n) * t]
      for (const off of [-margin, 0, margin]) {
        expect(keys).toContain(windowOf(e - dy * off, n + dx * off))
      }
    }
  })
})

describe('standingGround', () => {
  /** Four metres of flat terrain with a 9 m roof over the right half. */
  const win = (() => {
    const make = (fill: (col: number) => number) => {
      const g = Grid.filled(4, 1, 1000, 5_000_001, 1)
      for (let col = 0; col < 4; col++) g.data[col] = fill(col)
      return g
    }
    return {
      ground: make(() => 4),
      roof: make((col) => (col >= 2 ? 9 : NaN)),
    }
  })()

  it('reads the roof where there is a building and the terrain where there is not', () => {
    expect(standingGround(win, 1000.5, 5_000_000.5)).toBe(4)
    expect(standingGround(win, 1002.5, 5_000_000.5)).toBe(9)
  })

  it('keeps the terrain where a flattened roof sits below the slope under it', () => {
    const steep = { ...win, ground: Grid.filled(4, 1, 1000, 5_000_001, 1) }
    steep.ground.data.fill(11)
    expect(standingGround(steep, 1002.5, 5_000_000.5)).toBe(11)
  })
})
