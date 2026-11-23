import { describe, expect, it } from 'vitest'
import { drapeCells, surfaceAt } from './cellSurface.js'
import { polyline } from './segments.js'

/** Ground at 50, a 10 m building on every cell from e = 2 east. */
const block = (ci: number) => (ci >= 2 ? 60 : 50)

describe('surfaceAt', () => {
  it('is each cell itself at its centre, and ramps between centres across a wall', () => {
    expect(surfaceAt(block, 1.5, 0.5)).toBe(50)
    expect(surfaceAt(block, 2, 0.5)).toBe(55)
    expect(surfaceAt(block, 2.5, 0.5)).toBe(60)
  })
})

describe('drapeCells', () => {
  it('bends only where the surface does, at cell centres', () => {
    const d = polyline(drapeCells(block, 0.5, 0.5, 3.5, 0.5), (t, y) => [0.5 + 3 * t, y, 0])
    expect([...d].filter((_, i) => i % 3 !== 2)).toEqual([0.5, 50, 1.5, 50, 2.5, 60, 3.5, 60])
  })
})
