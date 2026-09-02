import { describe, expect, it } from 'vitest'
import { COVER, meshOf, samplePatch, type Readers } from './terrainMesh.js'

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
    // One missing corner, which is a corner of exactly one of the four cells.
    const patch = samplePatch(centre, 100, 3, flat())
    patch.height[0] = NaN
    expect(meshOf(patch).indices).toHaveLength(18)
    // A missing centre belongs to all four.
    const middle = samplePatch(centre, 100, 3, flat())
    middle.height[4] = NaN
    expect(meshOf(middle).indices).toHaveLength(0)
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
