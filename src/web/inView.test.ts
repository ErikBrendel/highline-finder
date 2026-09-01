import { describe, expect, it } from 'vitest'
import { overlaps, touches, type Bbox } from './inView.js'

/** A degree square with its corners at round numbers, so the arithmetic is readable. */
const view: Bbox = [52, 13, 53, 14]
const at = (lat: number, lon: number) => ({ lat, lon })

describe('overlaps', () => {
  it('is true for a box sharing only an edge, and false for one just clear of it', () => {
    expect(overlaps(view, [53, 14, 54, 15])).toBe(true)
    expect(overlaps(view, [53.001, 14.001, 54, 15])).toBe(false)
  })

  it('is false when only one axis overlaps', () => {
    expect(overlaps(view, [51, 13.2, 51.9, 13.8])).toBe(false)
    expect(overlaps(view, [52.2, 14.5, 52.8, 15])).toBe(false)
  })
})

describe('touches', () => {
  it('counts a line crossing the view with both anchors off it', () => {
    expect(touches(view, at(52.5, 12.5), at(52.5, 14.5))).toBe(true)
  })

  it('counts a line with one anchor inside, and rejects one entirely outside', () => {
    expect(touches(view, at(52.5, 13.5), at(52.5, 14.5))).toBe(true)
    expect(touches(view, at(51.5, 13.5), at(51.9, 13.6))).toBe(false)
  })

  it('rejects a line whose box overlaps in one axis only', () => {
    // Due south of the view and due east of it: overlapping longitudes, no overlapping latitudes.
    expect(touches(view, at(51.5, 13.2), at(51.6, 13.8))).toBe(false)
  })
})
