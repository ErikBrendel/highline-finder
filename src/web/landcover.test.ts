import { describe, expect, it } from 'vitest'
import { COVER_BUILDING, COVER_WATER, coverRuns, inRing } from './landcover.js'

describe('coverRuns', () => {
  it('groups each contiguous stretch of one class and ignores bare ground', () => {
    expect(coverRuns(Uint8Array.from([0, 1, 1, 0, 2, 2, 2, 0]))).toEqual([
      { from: 1, to: 2, kind: COVER_BUILDING },
      { from: 4, to: 6, kind: COVER_WATER },
    ])
  })

  it('splits adjacent stretches of different classes rather than merging them', () => {
    expect(coverRuns(Uint8Array.from([1, 2]))).toEqual([
      { from: 0, to: 0, kind: COVER_BUILDING },
      { from: 1, to: 1, kind: COVER_WATER },
    ])
  })
})

describe('inRing', () => {
  // An L, so a point inside the bounding box but outside the polygon is distinguishable.
  const l = [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 4 },
    { lat: 1, lon: 4 },
    { lat: 1, lon: 1 },
    { lat: 4, lon: 1 },
    { lat: 4, lon: 0 },
    { lat: 0, lon: 0 },
  ]

  it('accepts a point in the polygon and rejects one merely in its bounding box', () => {
    expect(inRing(l, 0.5, 2)).toBe(true)
    expect(inRing(l, 3, 3)).toBe(false)
  })

  it('rejects a point outside altogether', () => {
    expect(inRing(l, 5, 5)).toBe(false)
  })
})
