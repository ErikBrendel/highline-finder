import { describe, expect, it } from 'vitest'
import { regionId } from './regionCache.js'
import type { Aoi } from '../shared/types.js'

const at = (south: number): Aoi => ({ south, west: 13, north: south + 0.01, east: 13.01 })

describe('regionId', () => {
  it('names a region by the ground it covers', () => {
    expect(regionId([at(52)])).toBe(regionId([at(52)]))
    expect(regionId([at(52)])).not.toBe(regionId([at(53)]))
  })

  it('tells a merged region apart from either of its parts', () => {
    // Two areas close enough to be searched as one are a different region from either alone, and
    // must not be served each other's results.
    expect(regionId([at(52), at(52.02)])).not.toBe(regionId([at(52)]))
    expect(regionId([at(52), at(52.02)])).not.toBe(regionId([at(52.02)]))
  })

  it('distinguishes the same rectangles in a different order', () => {
    // Conservative on purpose: the order comes from the AOI list and reordering it is a change to
    // the input, so treating the two as the same cache entry would be assuming more than we know.
    expect(regionId([at(52), at(53)])).not.toBe(regionId([at(53), at(52)]))
  })
})
