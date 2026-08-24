import { describe, expect, it } from 'vitest'
import { parseUrl, toSearch, type UrlState } from './urlState.js'

const full: UrlState = {
  bbox: [52.1977, 13.6513, 52.2066, 13.6681],
  lineId: '408123.0_5784200.5__408380.0_5784310.0',
  custom: { a: { lat: 52.2001, lon: 13.6552 }, b: { lat: 52.2043, lon: 13.6614 } },
  rig: { a: 0.5, b: 1.2 },
  sagPct: 6.5,
  basemapMix: 1.4,
}

describe('url state', () => {
  it('round-trips everything it carries', () => {
    expect(parseUrl(toSearch(full))).toEqual(full)
  })

  it('carries nothing when there is nothing to carry', () => {
    expect(toSearch(parseUrl(''))).toBe('')
  })

  it('keeps a candidate id intact through encoding', () => {
    const search = toSearch({ ...full, custom: { a: null, b: null } })
    expect(parseUrl(search).lineId).toBe(full.lineId)
  })

  it('ignores malformed values rather than throwing', () => {
    const s = parseUrl('?at=1,2&a=notanumber&rig=0.5&sag=abc&b=52.2,13.6')
    expect(s.bbox).toBeNull()
    expect(s.custom.a).toBeNull()
    expect(s.rig).toBeNull()
    expect(s.sagPct).toBeNull()
    expect(s.custom.b).toEqual({ lat: 52.2, lon: 13.6 })
  })

  it('reads a basemap blend of zero rather than treating it as absent', () => {
    expect(parseUrl(toSearch({ ...full, basemapMix: 0 })).basemapMix).toBe(0)
  })

  it('rejects coordinates outside the world', () => {
    expect(parseUrl('?a=91,13.6').custom.a).toBeNull()
    expect(parseUrl('?a=52.2,181').custom.a).toBeNull()
  })

  it('keeps one end of a half-placed line', () => {
    const s = parseUrl(toSearch({ ...full, custom: { a: full.custom.a, b: null } }))
    expect(s.custom).toEqual({ a: full.custom.a, b: null })
  })
})
