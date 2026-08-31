import { describe, expect, it } from 'vitest'
import { clusterSpots, isWalkable, spotOf, type Endpoint, type Spot } from './hotspots.js'

// Kind plays no part in clustering -- run.ts partitions on it before calling in -- so one is enough.
const at = (
  e: number, n: number, score = 50, blocked = 0, more: Partial<Endpoint> = {},
): Endpoint => ({
  e, n, kind: 'natural', score, blocked, length: 100, exposure: 10, offLevel: 0, ...more,
})

/** The bounds an endpoint built by `at` with no overrides reduces to. */
const bounds = { lengthMin: 100, lengthMax: 100, exposureMax: 10, canopyMin: 0, offLevelMin: 0 }

/** A weighted point, as the grid produces them. */
const cell = (e: number, n: number, score = 50, count = 1): Spot =>
  ({ e, n, score, count, ...bounds })

describe('isWalkable', () => {
  it('takes a good line that clips some canopy', () => {
    expect(isWalkable(at(0, 0, 63, 0.2))).toBe(true)
  })

  it('rejects a line buried in canopy however it scores', () => {
    expect(isWalkable(at(0, 0, 70, 0.21))).toBe(false)
  })

  it('rejects a clear line that is barely a line', () => {
    // The case blockage alone cannot see: technically feasible, practically not worth the trip.
    expect(isWalkable(at(0, 0, 39, 0))).toBe(false)
  })
})

describe('clusterSpots', () => {
  it('stretches each bound over every endpoint in the spot', () => {
    const [spot] = clusterSpots([
      at(1002, 1000, 40, 0.1, { length: 300, exposure: 8, offLevel: 0.02 }),
      at(1005, 1005, 70, 0.0, { length: 120, exposure: 25, offLevel: 0.01 }),
    ].map(spotOf), 50)
    // A minimum on the slider reads the largest value here, a maximum the smallest -- so the two
    // bounds a filter can never ask about are simply not kept.
    expect(spot).toMatchObject({
      count: 2, score: 70,
      lengthMin: 120, lengthMax: 300, exposureMax: 25, canopyMin: 0, offLevelMin: 0.01,
    })
  })

  it('breaks a tie on position, not on which point arrived first', () => {
    const tied = [at(1010, 1000, 70), at(1002, 1000, 70)].map(spotOf)
    expect(clusterSpots(tied, 50)).toEqual(clusterSpots([...tied].reverse(), 50))
  })

  it('collapses everything within the radius into one spot', () => {
    const spots = clusterSpots([cell(0, 0), cell(30, 0), cell(0, 40)], 50)
    expect(spots).toHaveLength(1)
    expect(spots[0]!.count).toBe(3)
  })

  it('keeps points further apart than the radius separate', () => {
    expect(clusterSpots([cell(0, 0), cell(120, 0)], 50)).toHaveLength(2)
  })

  it('puts each spot on the best-scoring cell near it, and sums what they stand for', () => {
    const spots = clusterSpots([cell(0, 0, 40, 9), cell(20, 0, 70, 4), cell(10, 10, 55, 2)], 50)
    expect(spots).toEqual([{ e: 20, n: 0, score: 70, count: 15, ...bounds }])
  })

  it('finds neighbours across grid cell boundaries', () => {
    // Either side of the e=50 cell edge, 4 m apart.
    expect(clusterSpots([cell(48, 25), cell(52, 25)], 50)).toHaveLength(1)
  })

  it('counts every point of a dense cluster, across several grid cells', () => {
    // 28 x 28 m of points, so all of them are inside one 50 m radius of the best-scoring corner.
    const cells: Spot[] = []
    for (let i = 0; i < 200; i++) cells.push(cell((i % 10) * 3, Math.floor(i / 10) * 1.5, i))
    const spots = clusterSpots(cells, 50)
    expect(spots).toHaveLength(1)
    expect(spots[0]!.count).toBe(200)
  })
})

describe('hotspot order', () => {
  it('puts a spot in the same place however the cells were pooled', () => {
    // Two cells tied on score, close enough to collapse: which one the spot sits on must not
    // depend on the order they arrived in, or a chunked run would move spots at every seam.
    const cells = [cell(1000, 1000, 70), cell(1020, 1000, 70), cell(1010, 1000, 65)]
    const places = [
      [0, 1, 2], [2, 1, 0], [1, 2, 0],
    ].map((order) => clusterSpots(order.map((i) => cells[i]!), 50).map((s) => `${s.e},${s.n}`))
    expect(new Set(places.map((p) => p.join('|'))).size).toBe(1)
    expect(places[0]).toEqual(['1000,1000'])
  })
})
