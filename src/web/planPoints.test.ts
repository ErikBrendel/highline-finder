import { describe, expect, it } from 'vitest'
import { PLANNED_MAX_SPAN, place, spanGeometry } from './planPoints.js'
import { Grid } from '../shared/grid.js'
import { planLine } from '../shared/plan.js'
import { toWgs84 } from '../shared/geo.js'
import { DEFAULT_PARAMS } from '../pipeline/params.js'

// Tropical, one of the default AOIs. One degree of longitude here is ~68 km.
const a = { lat: 52.2, lon: 13.66 }
const near = { lat: 52.2, lon: 13.663 }
const far = { lat: 52.2, lon: 13.76 }

describe('place', () => {
  it('keeps both ends of a span within the cap', () => {
    expect(place({ a, b: null }, 'b', near)).toEqual({ a, b: near })
  })

  it('drops the far end rather than spanning further than the cap', () => {
    expect(place({ a, b: null }, 'b', far)).toEqual({ a: null, b: far })
    expect(place({ a: null, b: a }, 'a', far)).toEqual({ a: far, b: null })
  })

  it('clears one end without disturbing the other', () => {
    expect(place({ a, b: near }, 'b', null)).toEqual({ a, b: null })
  })
})

describe('PLANNED_MAX_SPAN', () => {
  it('is far beyond any riggable line, since it only guards fetching', () => {
    expect(PLANNED_MAX_SPAN).toBeGreaterThan(1000)
  })
})

describe('spanGeometry', () => {
  it('predicts the length and bearing the measurement will report', () => {
    // Flat ground at real Brandenburg coordinates, so the projection round-trip is meaningful.
    const e0 = 408_000
    const n1 = 5_784_500
    const grid = Grid.filled(400, 400, e0, n1, 1)
    grid.data.fill(50)
    const from = { e: e0 + 50, n: n1 - 200 }
    const to = { e: e0 + 290, n: n1 - 70 }

    const measured = planLine(from, to, grid, grid, DEFAULT_PARAMS.sagRatio, DEFAULT_PARAMS)!
    const predicted = spanGeometry(toWgs84(from.e, from.n), toWgs84(to.e, to.n))

    expect(predicted.length).toBeCloseTo(measured.candidate.length, 1)
    expect(predicted.bearing).toBe(measured.candidate.bearing)
  })
})
