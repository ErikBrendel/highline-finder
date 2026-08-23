import { describe, expect, it } from 'vitest'
import { windowsFor } from './terrain.js'

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
})
