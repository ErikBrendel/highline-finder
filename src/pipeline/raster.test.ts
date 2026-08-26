import { describe, expect, it } from 'vitest'
import { Grid, minFilter } from '../shared/grid.js'

import { gridFrom } from './testing.js'

describe('Grid', () => {
  it('places cell centres half a cell inside the top-left corner', () => {
    const g = gridFrom(10, 10, (e) => e)
    expect(g.nearest(0.5, 9.5)).toBeCloseTo(0.5)
    expect(g.nearest(9.5, 0.5)).toBeCloseTo(9.5)
  })

  it('returns NaN outside its extent', () => {
    const g = gridFrom(10, 10, () => 5)
    expect(g.at(-1, 0)).toBeNaN()
    expect(g.at(0, 10)).toBeNaN()
  })

  it('interpolates linearly along a ramp', () => {
    const g = gridFrom(20, 20, (e) => e)
    expect(g.sample(10, 10)).toBeCloseTo(10, 5)
    expect(g.sample(10.25, 10)).toBeCloseTo(10.25, 5)
  })

  it('falls back to nearest instead of returning NaN at the edge', () => {
    const g = gridFrom(10, 10, () => 7)
    expect(g.sample(0.1, 9.9)).toBeCloseTo(7)
  })

  it('reports extent over valid cells only', () => {
    const g = Grid.filled(3, 1, 0, 1, 1)
    g.data[0] = 5
    g.data[2] = 9
    expect(g.extent()).toEqual({ min: 5, max: 9, valid: 2 })
  })
})

describe('minFilter', () => {
  /** What the deque replaced: one comparison per cell of the window, holes skipped. */
  const naive = (g: Grid, radius: number): number[] => {
    const r = Math.max(0, Math.round(radius / g.res))
    const out: number[] = []
    for (let y = 0; y < g.h; y++) {
      for (let x = 0; x < g.w; x++) {
        let m = NaN
        for (let j = Math.max(0, y - r); j <= Math.min(g.h - 1, y + r); j++) {
          for (let i = Math.max(0, x - r); i <= Math.min(g.w - 1, x + r); i++) {
            const v = g.data[j * g.w + i]!
            if (v < m || Number.isNaN(m)) m = v
          }
        }
        out.push(m)
      }
    }
    return out
  }

  it('matches the window scan it replaced, holes and all', () => {
    // Deterministic noise with a third of the cells missing, so every window mixes real values with
    // no-data and the all-empty case actually occurs at the biggest radius.
    let seed = 3
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
    const w = 37
    const h = 23
    const data = Float32Array.from({ length: w * h }, () => (rnd() < 0.33 ? NaN : rnd() * 100))
    const grid = new Grid(data, w, h, 0, h, 1)
    for (const radius of [0, 1, 4, 25, 60]) {
      expect([...minFilter(grid, radius).data]).toEqual(naive(grid, radius))
    }
  })

  it('leaves a grid that is entirely no-data as no-data', () => {
    const empty = new Grid(new Float32Array(9).fill(NaN), 3, 3, 0, 3, 1)
    expect([...minFilter(empty, 1).data].every(Number.isNaN)).toBe(true)
  })
})
