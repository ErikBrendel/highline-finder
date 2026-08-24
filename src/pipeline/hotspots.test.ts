import { describe, expect, it } from 'vitest'
import { clusterEndpoints, type Endpoint } from './hotspots.js'

const at = (e: number, n: number, score = 50): Endpoint => ({ e, n, score })

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
