import { describe, expect, it } from 'vitest'
import { COVER, COVER_RGB, colorsOf, coverOf, meshOf, samplePatch, type Readers } from './terrainMesh.js'

const centre = { e: 400_000, n: 5_785_000 }

/** Flat bare ground everywhere, with whatever else the test wants layered on. */
const flat = (over: Partial<Readers> = {}): Readers => ({
  ground: () => 50,
  surface: () => 50,
  building: () => false,
  water: () => false,
  ...over,
})

describe('samplePatch', () => {
  it('spans the square it was asked for, north at row 0', () => {
    const seen: [number, number][] = []
    samplePatch(centre, 100, 3, flat({ ground: (e, n) => (seen.push([e, n]), 50) }))
    expect(seen[0]).toEqual([centre.e - 100, centre.n + 100])
    expect(seen[2]).toEqual([centre.e + 100, centre.n + 100])
    expect(seen[8]).toEqual([centre.e + 100, centre.n - 100])
  })

  it('reports the measured fraction and the range of what it saw', () => {
    // Half the square unsurveyed, the rest a ramp from 10 to 30.
    const patch = samplePatch(centre, 100, 3, flat({
      ground: (e) => (e < centre.e ? NaN : 10 + (e - centre.e) / 5),
      surface: (e) => (e < centre.e ? NaN : 10 + (e - centre.e) / 5),
    }))
    expect(patch.measured).toBeCloseTo(2 / 3)
    expect(patch.low).toBe(10)
    expect(patch.high).toBe(30)
  })

  it('takes the higher of bare earth and surface, so a roof is never buried', () => {
    const patch = samplePatch(centre, 10, 2, flat({ ground: () => 50, surface: () => 48 }))
    expect([...patch.height]).toEqual([50, 50, 50, 50])
  })
})

describe('cover', () => {
  const classOf = (over: Partial<Readers>) => samplePatch(centre, 10, 2, flat(over)).cover[0]

  it('calls a building a building whatever else is true of it', () => {
    expect(classOf({ building: () => true, water: () => true, surface: () => 60 })).toBe(
      COVER.building,
    )
  })

  it('needs two metres of something before it is canopy rather than noise', () => {
    expect(classOf({ surface: () => 51.9 })).toBe(COVER.ground)
    expect(classOf({ surface: () => 52 })).toBe(COVER.canopy)
  })

  it('calls open water water', () => {
    expect(classOf({ water: () => true })).toBe(COVER.water)
  })
})

describe('meshOf', () => {
  it('makes two triangles a cell and centres the patch on the origin', () => {
    const mesh = meshOf(samplePatch(centre, 100, 3, flat()))
    // 2x2 cells, six indices each.
    expect(mesh.indices).toHaveLength(24)
    expect(mesh.positions[0]).toBe(-100)
    expect(mesh.positions[2]).toBe(-100)
    // The far corner of the last vertex, and north is negative Z so row 0 was the -Z edge.
    expect(mesh.positions[8 * 3]).toBe(100)
    expect(mesh.positions[8 * 3 + 2]).toBe(100)
  })

  it('drops every cell touching ground nobody measured, rather than interpolating over it', () => {
    // Unmeasured ground is NaN in both readings, since neither reader has anything to give there.
    const blank = (at: number) => {
      const patch = samplePatch(centre, 100, 3, flat())
      patch.height[at] = NaN
      patch.ground[at] = NaN
      return patch
    }
    // One missing corner, which is a corner of exactly one of the four cells.
    expect(meshOf(blank(0)).indices).toHaveLength(18)
    // A missing centre belongs to all four.
    expect(meshOf(blank(4)).indices).toHaveLength(0)
  })

  it('measures height from the datum and leaves the other two axes alone', () => {
    const patch = samplePatch(centre, 100, 3, flat({ ground: () => 40, surface: () => 40 }))
    const [raw, floored] = [meshOf(patch), meshOf(patch, patch.low)]
    expect(raw.positions[1]).toBe(40)
    expect(floored.positions[1]).toBe(0)
    expect(floored.positions[0]).toBe(raw.positions[0])
    expect(floored.positions[2]).toBe(raw.positions[2])
  })
})

/**
 * Land cover outside Brandenburg is fetched while the view is already on screen, so the ground is
 * drawn brown and repainted when the lakes arrive. Repainting must not mean reading the heights
 * again -- that is a quarter of a million samples for a colour change.
 */
describe('coverOf', () => {
  const patch = samplePatch(centre, 10, 3, flat())

  it('finds what was not there when the heights were read', () => {
    expect([...patch.cover]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0])
    const wet = coverOf(patch, { building: () => false, water: () => true })
    expect([...wet]).toEqual(Array(9).fill(COVER.water))
  })

  it('walks the same grid, so a colour lands on the point it was read for', () => {
    const seen: [number, number][] = []
    coverOf(patch, { building: () => false, water: (e, n) => (seen.push([e, n]), false) })
    // Row 0 is the north edge and column 0 the west one, exactly as samplePatch reads them.
    expect(seen[0]).toEqual([centre.e - 10, centre.n + 10])
    expect(seen[8]).toEqual([centre.e + 10, centre.n - 10])
  })

  it('still knows canopy from the heights it already has', () => {
    const trees = samplePatch(centre, 10, 2, flat({ ground: () => 50, surface: () => 60 }))
    const again = coverOf(trees, { building: () => false, water: () => false })
    expect([...again]).toEqual(Array(4).fill(COVER.canopy))
  })
})

describe('colorsOf', () => {
  it('is three floats a vertex, in the palette the chart uses', () => {
    const colors = colorsOf(Uint8Array.from([COVER.water, COVER.ground]))
    expect(colors).toHaveLength(6)
    // Float32, so compared as such rather than against the doubles the palette is written in.
    for (const [i, want] of [...COVER_RGB[COVER.water], ...COVER_RGB[COVER.ground]].entries()) {
      expect(colors[i]).toBeCloseTo(want, 5)
    }
  })
})

/**
 * Two surfaces, not one. A wood is a thing you can see the shape of the hill through, so the
 * vegetation is its own translucent sheet and the solid ground beneath it stays solid ground.
 */
describe('the two mesh layers', () => {
  /** Flat earth at 50, with 10 m of trees over the eastern half. */
  const wooded = samplePatch(centre, 10, 4, flat({
    ground: () => 50,
    surface: (e) => (e >= centre.e ? 60 : 50),
  }))

  it('puts the solid ground on the earth, not on the treetops', () => {
    const solid = meshOf(wooded, 0)
    const ys = [...solid.positions].filter((_, i) => i % 3 === 1)
    expect(new Set(ys)).toEqual(new Set([50]))
  })

  it('puts the canopy sheet on the treetops', () => {
    const canopy = meshOf(wooded, 0, 'canopy')
    const used = new Set(
      [...canopy.indices].map((v) => canopy.positions[v * 3 + 1]),
    )
    expect(used).toEqual(new Set([60]))
  })

  it('draws no canopy where nothing is standing', () => {
    expect(meshOf(samplePatch(centre, 10, 3, flat()), 0, 'canopy').indices).toHaveLength(0)
  })

  it('keeps a building solid, since a roof is a floor and not a leaf', () => {
    const built = samplePatch(centre, 10, 2, flat({
      ground: () => 50, surface: () => 62, building: () => true,
    }))
    const ys = [...meshOf(built, 0).positions].filter((_, i) => i % 3 === 1)
    expect(new Set(ys)).toEqual(new Set([62]))
    expect(meshOf(built, 0, 'canopy').indices).toHaveLength(0)
  })

  it('hangs no green skirt from the treetops to the field beside them', () => {
    // The edge column is half wood and half open, so its quads belong to neither sheet whole.
    const canopy = meshOf(wooded, 0, 'canopy')
    const solid = meshOf(wooded, 0)
    expect(canopy.indices.length).toBeLessThan(solid.indices.length)
  })
})
