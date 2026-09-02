import { describe, expect, it } from 'vitest'
import {
  FILTER_DEFAULTS,
  changed,
  movedFilters,
  parseUrl,
  toSearch,
  type UrlState,
} from './urlState.js'

const everything: UrlState = {
  bbox: [52.1977, 13.6513, 52.2066, 13.6681],
  lineId: '408123.0_5784200.5__408380.0_5784310.0',
  custom: { a: { lat: 52.2001, lon: 13.6552 }, b: { lat: 52.2043, lon: 13.6614 } },
  rig: { a: 0.5, b: 1.2 },
  sagPct: 6.5,
  basemapMix: 1.4,
  showLines: false,
  showHotspots: false,
  showAreas: true,
  full: true,
  kinds: ['natural', 'urban'],
  filters: { minScore: 40, maxCanopy: 25 },
}

describe('url state', () => {
  it('round-trips everything it carries', () => {
    expect(parseUrl(toSearch(everything))).toEqual(everything)
  })

  it('carries nothing when there is nothing to carry', () => {
    expect(toSearch(parseUrl(''))).toBe('')
  })

  it('keeps a candidate id intact through encoding', () => {
    const search = toSearch({ ...everything, custom: { a: null, b: null } })
    expect(parseUrl(search).lineId).toBe(everything.lineId)
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
    expect(parseUrl(toSearch({ ...everything, basemapMix: 0 })).basemapMix).toBe(0)
  })

  it('writes nothing for a control left at its default', () => {
    // The whole point of the rule: a link carries what the sharer changed and nothing else, so
    // adding a control with a new default never invalidates a link written before it existed.
    const search = toSearch({
      ...everything,
      showLines: null,
      showHotspots: null,
      kinds: null,
      filters: {},
    })
    const params = ['lines', 'spots', 'kinds', 'score', 'len', 'maxlen', 'air', 'canopy', 'level']
    for (const absent of params) {
      expect(search).not.toContain(`${absent}=`)
    }
  })

  it('round-trips each slider on its own', () => {
    for (const [field, value] of [
      ['minScore', 40],
      ['minLength', 120],
      ['maxLength', 380],
      ['minExposure', 25],
      ['maxCanopy', 30],
      ['maxOffLevel', 1.5],
    ] as const) {
      const back = parseUrl(toSearch({ ...everything, filters: { [field]: value } }))
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
    const s = parseUrl(toSearch({ ...everything, custom: { a: everything.custom.a, b: null } }))
    expect(s.custom).toEqual({ a: everything.custom.a, b: null })
  })
})

describe('viewport precision', () => {
  const at = (s: string) => new URLSearchParams(s).get('at')!
  const box = (bbox: [number, number, number, number]) => at(toSearch({ ...everything, bbox }))

  it('writes a small view finely and a large one coarsely', () => {
    // A 900 m rectangle keeps five decimals; a whole region needs far fewer to land in the same
    // place, and the digits it does not need are noise in a shared link.
    expect(box([52.1977, 13.6513, 52.2066, 13.6681]).split(',')[0]).toBe('52.1977')
    expect(box([52.1, 13.1, 53.1, 14.1]).split(',')[0]).toBe('52.1')
  })

  it('never writes more than a metre of precision, however small the view', () => {
    for (const d of [0.00001, 0.0001, 0.001]) {
      for (const part of box([52.2, 13.6, 52.2 + d, 13.6 + d]).split(',')) {
        expect((part.split('.')[1] ?? '').length).toBeLessThanOrEqual(5)
      }
    }
  })

  it('rounds outward, so the stored rectangle always contains the real one', () => {
    // Rounding to nearest would let each share-reopen-reshare cycle crop a sliver off the view.
    const bbox: [number, number, number, number] = [52.10004, 13.10004, 52.59996, 13.59996]
    const [south, west, north, east] = box(bbox).split(',').map(Number) as [number, number, number, number]
    expect(south).toBeLessThanOrEqual(bbox[0])
    expect(west).toBeLessThanOrEqual(bbox[1])
    expect(north).toBeGreaterThanOrEqual(bbox[2])
    expect(east).toBeGreaterThanOrEqual(bbox[3])
  })

  it('stays inside a hundredth of the view on every side', () => {
    const bbox: [number, number, number, number] = [52.1977, 13.6513, 52.2066, 13.6681]
    const side = Math.min(bbox[2] - bbox[0], bbox[3] - bbox[1])
    const back = box(bbox).split(',').map(Number)
    for (const [i, v] of back.entries()) expect(Math.abs(v - bbox[i]!)).toBeLessThan(side * 0.01)
  })

  it('keeps a long thin view usable across its narrow side', () => {
    // The tolerance follows the smaller side, or a corridor would be coarsened into a square.
    const bbox: [number, number, number, number] = [52.2, 13.0, 52.201, 14.0]
    const [south] = box(bbox).split(',').map(Number) as [number]
    expect(Math.abs(south - 52.2)).toBeLessThan(0.00002)
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

describe('the area outlines', () => {
  // By parameter rather than by substring: `kinds=natural,urban` contains the word.
  const params = (s: UrlState) => new URLSearchParams(toSearch(s))

  it('stay out of a link until switched on', () => {
    expect(params({ ...everything, showAreas: false }).has('areas')).toBe(false)
    expect(params({ ...everything, showAreas: true }).get('areas')).toBe('1')
  })

  it('come back on from a link that carries them', () => {
    expect(parseUrl('?areas=1')).toMatchObject({ showAreas: true })
    expect(parseUrl('?areas=0')).toMatchObject({ showAreas: false })
    expect(parseUrl('')).toMatchObject({ showAreas: null })
  })
})
