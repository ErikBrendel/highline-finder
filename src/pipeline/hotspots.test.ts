import { describe, expect, it } from 'vitest'
import { clusterEndpoints, isWalkable, type Endpoint } from './hotspots.js'

// Kind plays no part in clustering -- run.ts partitions on it before calling in -- so one is enough.
const at = (e: number, n: number, score = 50, blocked = 0): Endpoint =>
  ({ e, n, kind: 'natural', score, blocked })

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

describe('clusterEndpoints', () => {
  it('collapses everything within the radius into one spot', () => {
    const spots = clusterEndpoints([at(0, 0), at(30, 0), at(0, 40)], 50)
    expect(spots).toHaveLength(1)
    expect(spots[0]!.count).toBe(3)
  })

  it('keeps points further apart than the radius separate', () => {
    expect(clusterEndpoints([at(0, 0), at(120, 0)], 50)).toHaveLength(2)
  })

  it('puts each spot on the best-scoring anchor near it', () => {
    const spots = clusterEndpoints([at(0, 0, 40), at(20, 0, 70), at(10, 10, 55)], 50)
    expect(spots).toHaveLength(1)
    expect(spots[0]).toMatchObject({ e: 20, n: 0, score: 70, count: 3 })
  })

  it('finds neighbours across grid cell boundaries', () => {
    // Either side of the e=50 cell edge, 4 m apart.
    expect(clusterEndpoints([at(48, 25), at(52, 25)], 50)).toHaveLength(1)
  })

  it('counts every point of a dense cluster, across several grid cells', () => {
    // 28 x 28 m of points, so all of them are inside one 50 m radius of the best-scoring corner.
    const points: Endpoint[] = []
    for (let i = 0; i < 200; i++) points.push(at((i % 10) * 3, Math.floor(i / 10) * 1.5, i))
    const spots = clusterEndpoints(points, 50)
    expect(spots).toHaveLength(1)
    expect(spots[0]!.count).toBe(200)
  })
})

describe('hotspot order', () => {
  it('puts a spot in the same place however the endpoints were pooled', () => {
    // Two endpoints tied on score, close enough to collapse: which one the spot sits on must not
    // depend on the order they arrived in, or a chunked run would move spots at every seam.
    const points = [at(1000, 1000, 70), at(1020, 1000, 70), at(1010, 1000, 65)]
    const places = [
      [0, 1, 2], [2, 1, 0], [1, 2, 0],
    ].map((order) => clusterEndpoints(order.map((i) => points[i]!), 50).map((s) => `${s.e},${s.n}`))
    expect(new Set(places.map((p) => p.join('|'))).size).toBe(1)
    expect(places[0]).toEqual(['1000,1000'])
  })
})
