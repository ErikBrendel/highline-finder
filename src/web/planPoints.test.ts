import { describe, expect, it } from 'vitest'
import { PLANNED_MAX_SPAN, place } from './planPoints.js'

// Sperenberg, where the default AOI is. One degree of longitude here is ~68 km.
const a = { lat: 52.2, lon: 13.66 }
const near = { lat: 52.2, lon: 13.663 }
const far = { lat: 52.2, lon: 13.76 }

describe('place', () => {
  it('keeps both ends of a span within the cap', () => {
    expect(place({ a, b: null }, 'b', near)).toEqual({ a, b: near })
  })

  it('drops the far end rather than spanning further than the cap', () => {
    expect(place({ a, b: null }, 'b', far)).toEqual({ a: null, b: far })
    expect(place({ a: null, b: a }, 'a', far)).toEqual({ a: far, b: null })
  })

  it('clears one end without disturbing the other', () => {
    expect(place({ a, b: near }, 'b', null)).toEqual({ a, b: null })
  })
})

describe('PLANNED_MAX_SPAN', () => {
  it('is far beyond any riggable line, since it only guards fetching', () => {
    expect(PLANNED_MAX_SPAN).toBeGreaterThan(1000)
  })
})
