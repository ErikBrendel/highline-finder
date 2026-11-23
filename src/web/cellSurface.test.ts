import { describe, expect, it } from 'vitest'
import { drapeCells, surfaceAt } from './cellSurface.js'
import { polyline } from './segments.js'

/** Ground at 50, a 10 m building on every cell from e = 2 east. */
const block = (ci: number) => (ci >= 2 ? 60 : 50)

describe('surfaceAt', () => {
  it('stands on one side of a wall right up to it, never partway up', () => {
    expect(surfaceAt(block, 1.99, 0.3)).toBe(50)
    expect(surfaceAt(block, 2.01, 0.3)).toBe(60)
  })

  it('runs smoothly over ground that only slopes', () => {
    const ramp = (ci: number) => ci * 0.5
    // Corners average the cells meeting there, so the surface is the ramp shifted half a cell.
    expect(surfaceAt(ramp, 3, 0.5)).toBeCloseTo(1.25)
    expect(surfaceAt(ramp, 3.5, 0.5)).toBeCloseTo(1.5)
  })
})

describe('drapeCells', () => {
  it('steps straight up the wall, at the wall', () => {
    const d = polyline(drapeCells(block, 0.5, 0.5, 3.5, 0.5), (t, y) => [0.5 + 3 * t, y, 0])
    const at = (e: number) => [...d].filter((_, i) => i % 3 === 1 && Math.abs(d[i - 1]! - e) < 1e-9)
    expect(at(2)).toEqual([50, 60])
    expect(at(1.5)).toEqual([50])
    expect(at(3)).toEqual([60])
  })
})
