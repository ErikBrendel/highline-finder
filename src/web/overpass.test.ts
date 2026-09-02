import { describe, expect, it } from 'vitest'
import { featuresFrom, patchKeysFor, PATCH } from './overpass.js'

/**
 * Overpass answers in latitude and longitude and in its own vocabulary; the rest of the app reads
 * projected metres and the block format. This is the seam, and a mistake in it is a road that is
 * not there or a lake that is.
 */
const way = (id: number, tags: Record<string, string>) => ({
  type: 'way' as const,
  id,
  tags,
  geometry: [
    { lat: 52.4, lon: 13.0 },
    { lat: 52.401, lon: 13.001 },
  ],
})

describe('featuresFrom', () => {
  it('classifies a road by the same rules the shipped extract uses', () => {
    const [road] = featuresFrom([way(1, { highway: 'secondary' })])
    expect(road!.kind).toBe('road')
    expect(road!.name).toBe('secondary')
    expect(road!.half).toBeGreaterThan(0)
    // Projected: a Brandenburg easting, not a longitude.
    expect(road!.pts[0]).toBeGreaterThan(100_000)
  })

  it('drops what neither classifier claims, rather than storing it as something', () => {
    expect(featuresFrom([way(2, { landuse: 'meadow' })])).toHaveLength(0)
  })

  it('keeps a tunnel out, since a line over one passes over ground', () => {
    expect(featuresFrom([way(3, { highway: 'primary', tunnel: 'yes' })])).toHaveLength(0)
  })

  it('marks a bridge, which is what holds a crossing up', () => {
    expect(featuresFrom([way(4, { highway: 'residential', bridge: 'yes' })])[0]!.bridge).toBe(true)
  })

  it('takes a lake as water and the island in it as an island', () => {
    const rings = featuresFrom([
      {
        type: 'relation',
        id: 9,
        tags: { natural: 'water' },
        members: [
          { role: 'outer', geometry: way(0, {}).geometry },
          { role: 'inner', geometry: way(0, {}).geometry },
        ],
      },
    ])
    expect(rings.map((r) => r.kind)).toEqual(['water', 'island'])
    // Negative and distinct, so a ring can never collide with a way id.
    expect(rings.every((r) => r.id < 0)).toBe(true)
    expect(rings[0]!.id).not.toBe(rings[1]!.id)
  })
})

describe('patchKeysFor', () => {
  const a = { e: 400_500, n: 5_785_500 }

  it('covers the square a point is in, and its neighbours within the margin', () => {
    expect(patchKeysFor(a, a, 0)).toEqual(['400-5785'])
    expect(patchKeysFor(a, a, 600).sort()).toEqual(
      ['399-5784', '399-5785', '399-5786', '400-5784', '400-5785', '400-5786', '401-5784', '401-5785', '401-5786'],
    )
  })

  it('covers every square a corridor crosses', () => {
    const b = { e: a.e + 3 * PATCH, n: a.n }
    expect(patchKeysFor(a, b, 0)).toHaveLength(4)
  })
})
