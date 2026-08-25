import { describe, expect, it } from 'vitest'
import {
  BLOCK,
  blockKey,
  blockKeysFor,
  blockOrigin,
  decodeBlock,
  encodeBlock,
  isRoadKind,
  splitFeatures,
  type OsmFeature,
} from './osmBlocks.js'

const roundTrip = (key: string, features: OsmFeature[]) =>
  decodeBlock(key, encodeBlock(key, features))

describe('block keys', () => {
  it('names the block a point falls in, and locates its corner', () => {
    expect(blockKey(419_663, 5_854_284)).toBe(`${Math.floor(419663 / BLOCK)}-${Math.floor(5854284 / BLOCK)}`)
    expect(blockOrigin('52-731')).toEqual({ e: 52 * BLOCK, n: 731 * BLOCK })
  })

  it('covers every block a box touches, corners included', () => {
    const keys = blockKeysFor(BLOCK - 1, BLOCK - 1, BLOCK + 1, BLOCK + 1)
    expect(new Set(keys)).toEqual(new Set(['0-0', '0-1', '1-0', '1-1']))
  })
})

describe('encode and decode', () => {
  const key = '52-731'
  const { e: e0, n: n0 } = blockOrigin(key)

  it('returns exactly what it was given, to a tenth of a metre', () => {
    const features: OsmFeature[] = [
      { id: 11, kind: 'street', name: 'residential', half: 3, bridge: false, pts: [e0 + 12.3, n0 + 45.6, e0 + 99.9, n0 + 12.1] },
      { id: 22, kind: 'highway', name: 'rail', half: 12.5, bridge: true, pts: [e0 + 1, n0 + 2, e0 + 3, n0 + 4, e0 + 5, n0 + 6] },
      { id: 33, kind: 'water', name: 'water', half: 0, bridge: false, pts: [e0, n0, e0 + 500, n0, e0 + 500, n0 + 500, e0, n0] },
    ]
    const back = roundTrip(key, features)
    expect(back).toHaveLength(3)
    expect(back.map((f) => f.id)).toEqual([11, 22, 33])
    for (let i = 0; i < features.length; i++) {
      const want = features[i]!
      const got = back[i]!
      expect(got.kind).toBe(want.kind)
      expect(got.name).toBe(want.name)
      expect(got.half).toBeCloseTo(want.half, 1)
      expect(got.bridge).toBe(want.bridge)
      for (let p = 0; p < want.pts.length; p++) expect(got.pts[p]).toBeCloseTo(want.pts[p]!, 1)
    }
  })

  it('survives coordinates far outside the block, which a long way has', () => {
    // Ways are written whole into every block they touch, so most of one can lie well outside it.
    const far: OsmFeature = {
      id: 44, kind: 'road', name: 'primary', half: 4, bridge: false,
      pts: [e0 - 40_000, n0 - 40_000, e0 + 40_000, n0 + 40_000],
    }
    const [got] = roundTrip(key, [far])
    for (let p = 0; p < far.pts.length; p++) expect(got!.pts[p]).toBeCloseTo(far.pts[p]!, 1)
  })

  it('round-trips a negated id, which is how a stitched water outline is identified', () => {
    const ring: OsmFeature = {
      id: -1234567, kind: 'water', name: 'water', half: 0, bridge: false,
      pts: [e0, n0, e0 + 40, n0, e0 + 40, n0 + 40, e0, n0],
    }
    const road: OsmFeature = {
      id: 987654321, kind: 'street', name: 'residential', half: 3, bridge: false,
      pts: [e0, n0, e0 + 10, n0],
    }
    const back = roundTrip(key, [road, ring])
    // Sorted by id on write, so the negative one comes first.
    expect(back.map((f) => f.id)).toEqual([-1234567, 987654321])
    expect(back[0]!.pts[2]).toBeCloseTo(e0 + 40, 1)
    expect(back[1]!.name).toBe('residential')
  })

  it('rejects bytes that are not a block, rather than returning nonsense', () => {
    expect(() => decodeBlock(key, new Uint8Array([1, 2, 3]))).toThrow()
  })

  it('drops a way already seen, which is how a way in two blocks stays one way', () => {
    const shared: OsmFeature = { id: 7, kind: 'street', name: 'residential', half: 3, bridge: false, pts: [e0, n0, e0 + 10, n0] }
    const lake: OsmFeature = { id: 8, kind: 'water', name: 'water', half: 0, bridge: false, pts: [e0, n0, e0 + 9, n0, e0, n0] }
    const seen = new Set<number>()
    const first = splitFeatures([shared, lake], seen)
    expect(first.roads).toHaveLength(1)
    expect(first.water.rings).toHaveLength(1)
    // The same block again, as the neighbouring block would deliver it.
    expect(splitFeatures([shared, lake], seen)).toEqual({
      roads: [],
      water: { rings: [], islands: [] },
    })
  })

  it('keeps an island apart from the lake it stands in', () => {
    const lake: OsmFeature = { id: 8, kind: 'water', name: 'water', half: 0, bridge: false, pts: [e0, n0, e0 + 40, n0, e0 + 40, n0 + 40, e0, n0 + 40, e0, n0] }
    const island: OsmFeature = { id: 9, kind: 'island', name: 'island', half: 0, bridge: false, pts: [e0 + 10, n0 + 10, e0 + 20, n0 + 10, e0 + 20, n0 + 20, e0 + 10, n0 + 20, e0 + 10, n0 + 10] }
    const back = decodeBlock(key, encodeBlock(key, [lake, island]))
    const split = splitFeatures(back, new Set())
    expect(split.water.rings).toHaveLength(1)
    expect(split.water.islands).toHaveLength(1)
  })

  it('separates the road tiers from the water kinds', () => {
    expect(isRoadKind('street')).toBe(true)
    expect(isRoadKind('highway')).toBe(true)
    expect(isRoadKind('water')).toBe(false)
    expect(isRoadKind('waterway')).toBe(false)
  })

  it('costs a couple of bytes per point on realistic geometry', () => {
    // A thousand-point way with nodes every 20 m or so, which is what a road actually looks like.
    const pts: number[] = []
    let e = e0 + 100
    let n = n0 + 100
    for (let i = 0; i < 1000; i++) {
      pts.push(e, n)
      e += 15 + (i % 7)
      n += 12 + (i % 5)
    }
    const bytes = encodeBlock(key, [{ id: 55, kind: 'street', name: 'residential', half: 3, bridge: false, pts }])
    // Four bytes per point uncompressed, and gzip takes it well under that.
    expect(bytes.length / 1000).toBeLessThan(4)
  })
})
