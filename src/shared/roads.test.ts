import { describe, expect, it } from 'vitest'
import {
  RoadIndex,
  classifyWay,
  crossingsAlong,
  requiredOver,
  withSpan,
  type RoadWay,
} from './roads.js'
import type { Crossing } from './types.js'
import { DEFAULT_PARAMS } from '../pipeline/params.js'

const p = DEFAULT_PARAMS

describe('classifyWay', () => {
  it('sorts the OSM hierarchy into the clearance ladder', () => {
    const tierOf = (tags: Record<string, string>) => classifyWay(tags)?.tier
    expect(tierOf({ highway: 'footway' })).toBe('path')
    expect(tierOf({ highway: 'cycleway' })).toBe('cycle')
    expect(tierOf({ highway: 'residential' })).toBe('street')
    expect(tierOf({ highway: 'secondary' })).toBe('road')
    expect(tierOf({ highway: 'motorway' })).toBe('highway')
  })

  it('puts every live railway at the top, electrified or not', () => {
    expect(classifyWay({ railway: 'rail', electrified: 'contact_line' })?.tier).toBe('highway')
    expect(classifyWay({ railway: 'tram' })?.tier).toBe('highway')
    expect(classifyWay({ railway: 'preserved' })?.tier).toBe('highway')
  })

  it('ignores a railway that is not there any more, or is not track', () => {
    // Five abandoned forest alignments took two thirds of the default area's candidates with them
    // when the railway key was read as a yes/no. There is no rail, no train and no wire on any of
    // them.
    for (const railway of ['abandoned', 'disused', 'razed', 'construction', 'proposed']) {
      expect(classifyWay({ railway })).toBeNull()
    }
    for (const railway of ['platform', 'station', 'switch', 'turntable', 'miniature']) {
      expect(classifyWay({ railway })).toBeNull()
    }
  })

  it('promotes a made-up track and demotes a driveway', () => {
    expect(classifyWay({ highway: 'track' })?.tier).toBe('path')
    expect(classifyWay({ highway: 'track', tracktype: 'grade1' })?.tier).toBe('cycle')
    expect(classifyWay({ highway: 'track', tracktype: 'grade4' })?.tier).toBe('path')
    expect(classifyWay({ highway: 'service' })?.tier).toBe('street')
    expect(classifyWay({ highway: 'service', service: 'driveway' })?.tier).toBe('cycle')
  })

  it('ignores a tunnel, which is under the ground rather than under the line', () => {
    expect(classifyWay({ highway: 'motorway', tunnel: 'yes' })).toBeNull()
    expect(classifyWay({ highway: 'motorway', tunnel: 'no' })?.tier).toBe('highway')
  })

  it('ignores anything that is not a way traffic uses', () => {
    expect(classifyWay({ building: 'yes' })).toBeNull()
    expect(classifyWay({ highway: 'bus_stop' })).toBeNull()
  })

  it('takes a width from the tags before falling back to the class', () => {
    expect(classifyWay({ highway: 'residential', width: '9' })?.half).toBe(4.5)
    expect(classifyWay({ highway: 'residential', lanes: '4' })?.half).toBe(6.5)
    // Neither tagged, so the default for a town street.
    expect(classifyWay({ highway: 'residential' })?.half).toBe(3)
    // A lane count only counts when it parses.
    expect(classifyWay({ highway: 'residential', lanes: 'yes' })?.half).toBe(3)
  })
})

describe('withSpan', () => {
  it('gives a crossing from an older dataset the stretch it never carried', () => {
    const old = { d: 100, half: 4, kind: 'residential', tier: 'street', onBridge: false }
    const fixed = withSpan(old as unknown as Crossing)
    expect(fixed.from).toBe(96)
    expect(fixed.to).toBe(104)
    expect(fixed.offset).toBe(0)
  })

  it('leaves a current crossing exactly as it is', () => {
    const now: Crossing = {
      d: 100, from: 90, to: 110, offset: 2, kind: 'x', tier: 'street', onBridge: false,
    }
    expect(withSpan(now)).toBe(now)
  })
})

describe('requiredOver', () => {
  it('is the base clearance plus the class surcharge', () => {
    const at = (tier: 'path' | 'highway') =>
      requiredOver({ d: 0, from: 0, to: 0, offset: 0, kind: 'x', tier, onBridge: false }, p)
    expect(at('path')).toBe(p.minClearance)
    expect(at('highway')).toBe(p.minClearance + p.roadClearance.highway)
  })
})

/** A way running north-south through `e`, spanning the whole fixture. */
const northSouth = (e: number, tier: RoadWay['tier'] = 'street'): RoadWay => ({
  tier,
  kind: 'residential',
  half: 3,
  bridge: false,
  pts: [e, 0, e, 1000],
})

describe('crossingsAlong', () => {
  const a = { e: 0, n: 500 }
  const b = { e: 400, n: 500 }

  it('reports the distance along the span where the way is', () => {
    const [x] = crossingsAlong(a, b, [northSouth(120)], p)
    expect(x!.d).toBeCloseTo(120, 1)
    expect(x!.tier).toBe('street')
  })

  it('reports each touch of a way that crosses more than once', () => {
    // A hairpin: east across the span, back west, then east again.
    const zigzag: RoadWay = {
      ...northSouth(0),
      pts: [100, 400, 100, 600, 200, 600, 200, 400, 300, 400, 300, 600],
    }
    expect(crossingsAlong(a, b, [zigzag], p).map((x) => Math.round(x.d))).toEqual([100, 200, 300])
  })

  it('ignores a way that stops short of the band', () => {
    // 100 m off the span, against a band that reaches 16 m at midspan plus a 3 m half-carriageway.
    const short: RoadWay = { ...northSouth(0), pts: [120, 0, 120, 400] }
    expect(crossingsAlong(a, b, [short], p)).toEqual([])
  })

  it('reports a way running alongside the span, which never crosses it at all', () => {
    // The case a segment-intersection test cannot see, and the reason for the band: this road is
    // under the line for most of its length once the wind gets up.
    const alongside: RoadWay = { ...northSouth(0), pts: [80, 508, 320, 508] }
    const [x] = crossingsAlong(a, b, [alongside], p)
    expect(x).toBeDefined()
    expect(x!.offset).toBeCloseTo(5, 1)
    // The stretch reaches a little past the road's own ends, because the band reaches it
    // diagonally before the span draws level with it.
    expect(x!.from).toBeLessThan(80)
    expect(x!.to).toBeGreaterThan(320)
  })

  it('reads the road\'s own height, not the ground under the line', () => {
    // The case that matters once a crossing can sit off to the side: the span leaves a roof at 30 m
    // and the street passes 8 m beside it at street level. Measuring down from the roof would say
    // the street has 30 m less air over it than it has.
    const alongside: RoadWay = { ...northSouth(0), pts: [80, 508, 320, 508] }
    const height = (_e: number, n: number) => (n > 504 ? 12 : 42)
    const elevation = {
      ground: { sample: height, nearest: height },
      surface: { sample: () => 0, nearest: () => 0 },
    }
    const [x] = crossingsAlong(a, b, [alongside], p, elevation)
    expect(x!.carrier).toBe(12)
  })

  it('leaves the carrier unset when there is no elevation model to read it from', () => {
    expect(crossingsAlong(a, b, [northSouth(120)], p)[0]!.carrier).toBeUndefined()
  })

  it('leaves a road outside the band alone however long it runs beside the span', () => {
    const far: RoadWay = { ...northSouth(0), pts: [0, 530, 400, 530] }
    expect(crossingsAlong(a, b, [far], p)).toEqual([])
  })

  it('ignores a way beyond the far anchor', () => {
    expect(crossingsAlong(a, b, [northSouth(500)], p)).toEqual([])
  })
})

describe('RoadIndex', () => {
  const build = (...ways: RoadWay[]) => {
    const index = new RoadIndex()
    for (const w of ways) index.add(w)
    return index
  }

  it('finds the same crossings the exhaustive scan would', () => {
    const ways = [northSouth(120), northSouth(275), northSouth(900)]
    const a = { e: 0, n: 500 }
    const b = { e: 400, n: 500 }
    expect(build(...ways).crossings(a, b, p)).toEqual(crossingsAlong(a, b, ways, p))
  })

  it('reports a crossing once however many buckets its segment was filed in', () => {
    // A single long segment spans many 100 m buckets, and a diagonal span visits several of them.
    const index = build({ ...northSouth(0), pts: [250, 0, 250, 1000] })
    expect(index.crossings({ e: 0, n: 0 }, { e: 600, n: 900 }, p)).toHaveLength(1)
  })

  it('finds a road in a bucket the span only just enters', () => {
    /**
     * The case that makes the walk an exact grid traversal rather than sampled steps. This span
     * clips the last 12 m of bucket (7, 8) after its final sample point, and the road below sits
     * wholly inside that bucket -- so a walk that merely samples the span every half cell files no
     * lookup there and the road is never seen. Found by search, not by guessing: sampled steps miss
     * a bucket on roughly one span in ten thousand, which is often enough to matter over millions
     * of them and rare enough that no fixture written by hand happens to catch it.
     */
    const index = build({ ...northSouth(0), pts: [790, 805, 799, 805] })
    const found = index.crossings({ e: 541.6, n: 216.9 }, { e: 800.7, n: 812.4 }, p)
    expect(found).toHaveLength(1)
    expect(found[0]!.d).toBeCloseTo(641.4, 0)
  })

  it('agrees with the exhaustive scan over a few hundred random spans', () => {
    /**
     * The property that matters, and not one a hand-picked fixture establishes: bucketing is only
     * a speed-up, so it has to return exactly what scanning every way would, for every span. Both
     * ways this can break are silent -- a span clipping the corner of a bucket the walk stepped
     * over loses a road, and a segment filed in two visited buckets reports one road twice.
     */
    let seed = 11
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
    const ways: RoadWay[] = []
    for (let i = 0; i < 60; i++) {
      const pts: number[] = []
      let e = rnd() * 1000
      let n = rnd() * 1000
      for (let k = 0; k < 2 + Math.floor(rnd() * 4); k++) {
        pts.push(e, n)
        e += (rnd() - 0.5) * 300
        n += (rnd() - 0.5) * 300
      }
      ways.push({ ...northSouth(0), pts })
    }
    const index = build(...ways)

    for (let trial = 0; trial < 300; trial++) {
      const a = { e: rnd() * 1000, n: rnd() * 1000 }
      const b = { e: rnd() * 1000, n: rnd() * 1000 }
      expect(index.crossings(a, b, p)).toEqual(crossingsAlong(a, b, ways, p))
    }
  })

  it('answers nothing, cheaply, where there is no road at all', () => {
    expect(build(northSouth(900)).crossings({ e: 0, n: 0 }, { e: 400, n: 0 }, p)).toEqual([])
  })
})
