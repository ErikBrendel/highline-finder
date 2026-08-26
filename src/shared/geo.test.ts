import { describe, expect, it } from 'vitest'
import { bearingOf, oppositeBearing, sectorOf, tileId, tilesForBounds, toUtm33, toWgs84 } from './geo.js'

describe('projection', () => {
  // Reference values taken from the AOI corner used throughout the project.
  it('projects the AOI corner to the expected EPSG:25833 position', () => {
    const [e, n] = toUtm33(52.199278, 13.651291)
    expect(e).toBeCloseTo(407824.2, 0)
    expect(n).toBeCloseTo(5784060.1, 0)
  })

  it('round-trips', () => {
    const { lat, lon } = toWgs84(...toUtm33(52.2066, 13.6661))
    expect(lat).toBeCloseTo(52.2066, 6)
    expect(lon).toBeCloseTo(13.6661, 6)
  })
})

describe('tiles', () => {
  it('names a tile after the km values of its south-west corner', () => {
    expect(tileId(407824, 5784060)).toBe('33407-5784')
    expect(tileId(408000, 5785000)).toBe('33408-5785')
  })

  it('covers every tile the AOI touches', () => {
    expect(tilesForBounds(407824, 5784041, 408854, 5784878)).toEqual([
      '33407-5784',
      '33408-5784',
    ])
  })

  it('stops at the last tile the box reaches into, not the one its edge sits on', () => {
    // A superchunk's edges are exact kilometre multiples, so this case fires on every side at once.
    // 416000..424000 is eight tiles, 416 to 423; tile 424 begins where the box ends.
    const ids = tilesForBounds(416000, 5824000, 424000, 5832000)
    expect(ids).toHaveLength(64)
    expect(ids).toContain('33423-5831')
    expect(ids).not.toContain('33424-5824')
    expect(ids).not.toContain('33416-5832')
  })

  it('still returns the one tile a box smaller than a tile sits in', () => {
    expect(tilesForBounds(416100, 5824100, 416200, 5824200)).toEqual(['33416-5824'])
  })
})

describe('bearings', () => {
  it('measures clockwise from north', () => {
    expect(bearingOf(0, 1)).toBeCloseTo(0)
    expect(bearingOf(1, 0)).toBeCloseTo(Math.PI / 2)
    expect(bearingOf(0, -1)).toBeCloseTo(Math.PI)
    expect(bearingOf(-1, 0)).toBeCloseTo((3 * Math.PI) / 2)
  })

  it('maps a bearing into one of N sectors', () => {
    expect(sectorOf(0, 64)).toBe(0)
    expect(sectorOf(Math.PI, 64)).toBe(32)
    expect(sectorOf(2 * Math.PI - 1e-9, 64)).toBe(63)
  })

  it('reverses without leaving the 0..2pi range', () => {
    expect(oppositeBearing(0.5)).toBeCloseTo(0.5 + Math.PI)
    expect(oppositeBearing(Math.PI + 0.5)).toBeCloseTo(0.5)
  })
})
