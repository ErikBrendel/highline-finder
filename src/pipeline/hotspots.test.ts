import { describe, expect, it } from 'vitest'
import { clusterSpots, gridSpots, isWalkable, spotOf, type Endpoint, type Spot } from './hotspots.js'

// Kind plays no part in clustering -- run.ts partitions on it before calling in -- so one is enough.
const at = (e: number, n: number, score = 50, blocked = 0): Endpoint =>
  ({ e, n, kind: 'natural', score, blocked })

/** A weighted point, as the grid produces them. */
const cell = (e: number, n: number, score = 50, count = 1): Spot => ({ e, n, score, count })

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

describe('gridSpots', () => {
  it('keeps one point per cell, on the best endpoint, counting them all', () => {
    const spots = gridSpots([at(1002, 1000, 40), at(1018, 1012, 70), at(1005, 1005, 55)].map(spotOf), 25)
    expect(spots).toEqual([{ e: 1018, n: 1012, score: 70, count: 3 }])
  })

  it('keeps points in different cells apart', () => {
    expect(gridSpots([at(1000, 1000), at(1030, 1000)].map(spotOf), 25)).toHaveLength(2)
  })

  /**
   * The property the chunked plan rests on: an aggregate built piecewise has to equal the one built
   * whole, or every seam between two runs would move the map.
   */
  it('adds up the same however the points were split between runs', () => {
    const points = Array.from({ length: 60 }, (_, i) =>
      spotOf(at(1000 + (i % 7) * 9, 1000 + Math.floor(i / 7) * 11, 40 + (i % 13))))
    const whole = gridSpots(points, 25)
    for (const cut of [1, 17, 43]) {
      const pieces = [points.slice(0, cut), points.slice(cut)].map((part) => gridSpots(part, 25))
      expect(gridSpots(pieces.flat(), 25)).toEqual(whole)
    }
  })

  it('breaks a tie on position, not on which point arrived first', () => {
    const tied = [at(1010, 1000, 70), at(1002, 1000, 70)].map(spotOf)
    expect(gridSpots(tied, 25)).toEqual(gridSpots([...tied].reverse(), 25))
  })
})

describe('clusterSpots', () => {
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
    expect(spots).toEqual([{ e: 20, n: 0, score: 70, count: 15 }])
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
