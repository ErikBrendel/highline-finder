import { describe, expect, it } from 'vitest'
import { RIG_RATE, rigCost, rigMeans, type Standing, RoofMask, lineKind, rigRange } from './anchoring.js'
import { Grid } from './grid.js'
import { DEFAULT_PARAMS } from '../pipeline/params.js'

const p = DEFAULT_PARAMS

describe('rigRange', () => {
  it('gives open ground the A-frame range and a roof none at all', () => {
    expect(rigRange(false, p)).toEqual({ min: p.aFrameMin, max: p.aFrameMax })
    expect(rigRange(true, p)).toEqual({ min: 0, max: 0 })
  })
})

describe('lineKind', () => {
  it('calls a line urban as soon as either end is on a roof', () => {
    expect(lineKind(false, false)).toBe('natural')
    expect(lineKind(true, false)).toBe('urban')
    expect(lineKind(false, true)).toBe('urban')
    expect(lineKind(true, true)).toBe('urban')
  })
})

describe('RoofMask', () => {
  /** A 10 m region, with a 3x3 m building in its top-left quadrant. */
  const region = () => Grid.filled(10, 10, 1000, 2010, 1)
  const building = () => {
    const g = Grid.filled(3, 3, 1002, 2008, 1)
    g.data.fill(30)
    return g
  }

  it('covers exactly the cells the source grid holds a height in', () => {
    const mask = RoofMask.forGrid(region())
    mask.add(building())
    expect(mask.count()).toBe(9)
    expect(mask.covers(1002.5, 2007.5)).toBe(true)
    expect(mask.covers(1004.5, 2005.5)).toBe(true)
    // Just past the far corner of the building, and well away from it.
    expect(mask.covers(1005.5, 2005.5)).toBe(false)
    expect(mask.covers(1002.5, 2004.5)).toBe(false)
    expect(mask.covers(1008.5, 2001.5)).toBe(false)
  })

  it('ignores nodata cells, so a partly filled tile marks only its building', () => {
    const roofs = building()
    roofs.data[4] = NaN
    const mask = RoofMask.forGrid(region())
    mask.add(roofs)
    expect(mask.count()).toBe(8)
    expect(mask.covers(1003.5, 2006.5)).toBe(false)
  })

  it('drops what falls outside the region, as the height blit does', () => {
    const mask = RoofMask.forGrid(region())
    const straddling = Grid.filled(3, 3, 1009, 2005, 1)
    straddling.data.fill(30)
    mask.add(straddling)
    // The region ends at e = 1010, so only the first of the three columns lands in it.
    expect(mask.count()).toBe(3)
    expect(mask.covers(1009.5, 2003.5)).toBe(true)
    expect(mask.covers(1010.5, 2003.5)).toBe(false)
  })

  it('reports nothing outside the region rather than reading the wrong cell', () => {
    const mask = RoofMask.forGrid(region())
    mask.add(building())
    expect(mask.covers(999, 2005)).toBe(false)
    expect(mask.covers(1005, 2020)).toBe(false)
  })
})

/**
 * Every height is reachable by something, so the question is what by -- and the price is banded so
 * that two anchors a centimetre apart never score a tier apart.
 */
describe('rigMeans and rigCost', () => {
  const open = (canopy = 0): Standing => ({ onRoof: false, canopy })
  const roof: Standing = { onRoof: true, canopy: 0 }

  it('names what a height needs, on ground with a wood on it', () => {
    const wood = open(24)
    expect(rigMeans(0, wood, p)).toBe('edge')
    expect(rigMeans(1.2, wood, p)).toBe('aFrame')
    expect(rigMeans(8, wood, p)).toBe('trunk')
    expect(rigMeans(12, wood, p)).toBe('trunk')
    expect(rigMeans(18, wood, p)).toBe('crown')
    expect(rigMeans(30, wood, p)).toBe('brought')
  })

  it('has nothing to climb in an open field or on a roof', () => {
    expect(rigMeans(4, open(), p)).toBe('brought')
    expect(rigMeans(0, roof, p)).toBe('edge')
    expect(rigMeans(0.5, roof, p)).toBe('brought')
  })

  it('charges nothing for what a carried A-frame reaches', () => {
    expect(rigCost(0, open(24), p)).toBe(0)
    expect(rigCost(p.aFrameMax, open(24), p)).toBe(0)
    expect(rigCost(0, roof, p)).toBe(0)
  })

  it('charges each metre at the rate of the band it falls in', () => {
    const wood = open(24)
    expect(rigCost(12, wood, p)).toBeCloseTo(10.5 * RIG_RATE.trunk, 6)
    expect(rigCost(24, wood, p)).toBeCloseTo(10.5 * RIG_RATE.trunk + 12 * RIG_RATE.crown, 6)
    expect(rigCost(26, wood, p)).toBeCloseTo(
      10.5 * RIG_RATE.trunk + 12 * RIG_RATE.crown + 2 * RIG_RATE.brought,
      6,
    )
  })

  it('rises without a step anywhere, so a hill-climb has a downhill to follow', () => {
    const wood = open(24)
    let last = -1
    for (let h = 0; h <= 40; h += 0.05) {
      const cost = rigCost(h, wood, p)
      expect(cost).toBeGreaterThanOrEqual(last)
      last = cost
    }
    // No jump larger than one step at the steepest rate: continuity, stated as a number.
    for (let h = 0; h <= 40; h += 0.05) {
      expect(rigCost(h + 0.05, wood, p) - rigCost(h, wood, p)).toBeLessThanOrEqual(
        0.05 * RIG_RATE.brought + 1e-9,
      )
    }
  })

  it('prices a climb far below a mast for the same height', () => {
    expect(rigCost(8, open(24), p)).toBeLessThan(rigCost(8, open(), p) / 5)
  })
})
