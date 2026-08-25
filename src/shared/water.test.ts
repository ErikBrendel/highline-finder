import { describe, expect, it } from 'vitest'
import { WaterMask, clearanceNeeded } from './water.js'
import { DEFAULT_PARAMS } from '../pipeline/params.js'

const p = DEFAULT_PARAMS

/** A 100 m square raster with its top-left corner at (0, 100), one metre to the cell. */
const geom = { w: 100, h: 100, e0: 0, n1: 100, res: 1 }

/** A closed rectangular ring, flat as `[e, n, ...]`. */
const box = (e0: number, n0: number, e1: number, n1: number) =>
  [e0, n0, e1, n0, e1, n1, e0, n1, e0, n0]

describe('clearanceNeeded', () => {
  it('asks less over water than over ground', () => {
    expect(clearanceNeeded(true, p)).toBe(p.waterClearance)
    expect(clearanceNeeded(false, p)).toBe(p.minClearance)
    expect(p.waterClearance).toBeLessThan(p.minClearance)
  })
})

describe('WaterMask', () => {
  it('covers the inside of an outline and nothing beyond it', () => {
    const mask = new WaterMask(geom)
    mask.add({ rings: [box(20, 20, 60, 60)], islands: [] })
    expect(mask.covers(40, 40)).toBe(true)
    expect(mask.covers(10, 40)).toBe(false)
    expect(mask.covers(40, 70)).toBe(false)
  })

  it('leaves an island inside a lake as dry ground', () => {
    // The case that makes this worth doing: a wooded island in a Brandenburg lake is exactly the
    // thing a line must not be offered a metre of clearance over.
    const mask = new WaterMask(geom)
    mask.add({ rings: [box(10, 10, 90, 90)], islands: [box(40, 40, 60, 60)] })
    expect(mask.covers(20, 20)).toBe(true)
    expect(mask.covers(50, 50)).toBe(false)
    // Still water right up to the island's shore.
    expect(mask.covers(38, 50)).toBe(true)
  })

  it('punches islands out after every outline is drawn, not as it goes', () => {
    // Two overlapping lakes with one island between them. Clearing as each lake was drawn would let
    // the second fill the island back in.
    const mask = new WaterMask(geom)
    mask.add({
      rings: [box(10, 10, 60, 90), box(40, 10, 90, 90)],
      islands: [box(45, 40, 55, 60)],
    })
    expect(mask.covers(50, 50)).toBe(false)
    expect(mask.covers(30, 50)).toBe(true)
    expect(mask.covers(70, 50)).toBe(true)
  })

  it('reports nothing outside the raster rather than wrapping round it', () => {
    const mask = new WaterMask(geom)
    mask.add({ rings: [box(-50, -50, 50, 50)], islands: [] })
    expect(mask.covers(20, 20)).toBe(true)
    expect(mask.covers(-10, 20)).toBe(false)
    expect(mask.covers(20, 200)).toBe(false)
  })
})
