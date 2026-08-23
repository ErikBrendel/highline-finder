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
