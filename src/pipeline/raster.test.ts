import { describe, expect, it } from 'vitest'
import { Grid } from '../shared/grid.js'
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
