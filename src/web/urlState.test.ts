import { describe, expect, it } from 'vitest'
import {
  FILTER_DEFAULTS,
  changed,
  movedFilters,
  parseUrl,
  toSearch,
  type UrlState,
} from './urlState.js'

const full: UrlState = {
  bbox: [52.1977, 13.6513, 52.2066, 13.6681],
  lineId: '408123.0_5784200.5__408380.0_5784310.0',
  custom: { a: { lat: 52.2001, lon: 13.6552 }, b: { lat: 52.2043, lon: 13.6614 } },
  rig: { a: 0.5, b: 1.2 },
  sagPct: 6.5,
  basemapMix: 1.4,
  showLines: false,
  showHotspots: false,
  kinds: ['natural', 'urban'],
  filters: { minScore: 40, maxCanopy: 25 },
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

  it('writes nothing for a control left at its default', () => {
    // The whole point of the rule: a link carries what the sharer changed and nothing else, so
    // adding a control with a new default never invalidates a link written before it existed.
    const search = toSearch({
      ...full,
      showLines: null,
      showHotspots: null,
      kinds: null,
      filters: {},
    })
    for (const absent of ['lines', 'spots', 'kinds', 'score', 'len', 'air', 'canopy', 'level']) {
      expect(search).not.toContain(`${absent}=`)
    }
  })

  it('round-trips each slider on its own', () => {
    for (const [field, value] of [
      ['minScore', 40],
      ['minLength', 120],
      ['minExposure', 25],
      ['maxCanopy', 30],
      ['maxOffLevel', 1.5],
    ] as const) {
      const back = parseUrl(toSearch({ ...full, filters: { [field]: value } }))
      expect(back.filters).toEqual({ [field]: value })
    }
  })

  it('turns a layer off only for an explicit zero', () => {
    expect(parseUrl('?lines=0').showLines).toBe(false)
    expect(parseUrl('?lines=1').showLines).toBe(true)
    // Absent is not the same as off: it means the default, which the caller supplies.
    expect(parseUrl('').showLines).toBeNull()
  })

  it('keeps an empty kind list, which means show no lines at all', () => {
    expect(parseUrl('?kinds=').kinds).toEqual([])
    // But a parameter naming nothing recognisable is a broken link, not a request for an empty map.
    expect(parseUrl('?kinds=rooftop,bridge').kinds).toBeNull()
  })

  it('reports kinds in a fixed order however the link listed them', () => {
    expect(parseUrl('?kinds=urban,natural').kinds).toEqual(['natural', 'urban'])
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

describe('changed', () => {
  it('drops a value that equals the default and keeps one that does not', () => {
    expect(changed(2, 2)).toBeNull()
    expect(changed(1.4, 2)).toBe(1.4)
    expect(changed(false, true)).toBe(false)
  })
})

describe('movedFilters', () => {
  it('reports only the sliders that have been moved', () => {
    expect(movedFilters(FILTER_DEFAULTS)).toEqual({})
    expect(movedFilters({ ...FILTER_DEFAULTS, minLength: 200, maxCanopy: 10 })).toEqual({
      minLength: 200,
      maxCanopy: 10,
    })
  })
})
