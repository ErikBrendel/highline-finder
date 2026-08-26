import { describe, expect, it } from 'vitest'
import {
  BLEND_STOPS,
  ageText,
  squareRing,
  MIX_MAX,
  basemapOpacity,
  basemapVisible,
  lineOpacity,
  lineWidth,
  stopAt,
} from './MapView.js'
import { SHADE_BASELINE, applyShading } from './shaded.js'
import { toUtm33, toWgs84 } from '../shared/geo.js'

const n = BLEND_STOPS.length

describe('basemap cross-fade', () => {
  it('shows exactly one stop at each whole position', () => {
    for (let stop = 0; stop < n; stop++) {
      const shown = BLEND_STOPS.map((_, i) => i).filter((i) => basemapVisible(i, stop, n))
      expect(shown).toEqual([stop])
      expect(basemapOpacity(stop, stop)).toBe(1)
    }
  })

  it('blends the two adjacent stops in between', () => {
    const shown = BLEND_STOPS.map((_, i) => i).filter((i) => basemapVisible(i, 0.5, n))
    expect(shown).toEqual([0, 1])
    expect(basemapOpacity(1, 0.5)).toBeCloseTo(0.5)
    expect(basemapOpacity(0, 0.5)).toBe(1)
  })

  it('never lets the background show through', () => {
    for (let at = 0; at <= n - 1; at += 0.25) {
      const bottom = BLEND_STOPS.map((_, i) => i).filter((i) => basemapVisible(i, at, n)).shift()!
      expect(basemapOpacity(bottom, at)).toBe(1)
    }
  })

  it('hides layers a fully opaque layer already covers, so their tiles are not fetched', () => {
    // At the far end only OSM is drawn, even though the layers below it still exist.
    expect(basemapVisible(0, n - 1, n)).toBe(false)
    expect(basemapVisible(n - 2, n - 1, n)).toBe(false)
    expect(basemapVisible(n - 1, n - 1, n)).toBe(true)
  })
})

describe('stopAt', () => {
  it('keeps the three named maps on the whole numbers a shared link already uses', () => {
    // The reason the slider still runs 0-2: map=1 in a link written before the shaded composites
    // existed has to still mean pure hillshade.
    expect(BLEND_STOPS[stopAt(0)]!.id).toBe('ortho')
    expect(BLEND_STOPS[stopAt(1)]!.id).toBe('hillshade')
    expect(BLEND_STOPS[stopAt(MIX_MAX)]!.id).toBe('osm')
  })

  it('puts a shaded composite under each halfway mark', () => {
    expect(BLEND_STOPS[stopAt(0.5)]!.id).toBe('orthoShaded')
    expect(BLEND_STOPS[stopAt(1.5)]!.id).toBe('osmShaded')
  })
})

describe('applyShading', () => {
  /** One pixel of each, as the canvas hands them over: RGBA, eight bits a channel. */
  const px = (r: number, g: number, b: number) => Uint8ClampedArray.from([r, g, b, 255])

  it('leaves a pixel untouched where the terrain is flat', () => {
    const base = px(120, 60, 30)
    applyShading(base, px(SHADE_BASELINE, SHADE_BASELINE, SHADE_BASELINE))
    expect([...base]).toEqual([120, 60, 30, 255])
  })

  it('scales all three channels together, so the colour keeps its hue', () => {
    const base = px(120, 60, 30)
    applyShading(base, px(98, 98, 98))
    // Half the baseline, so half of everything -- the 2:1 ratio between the channels survives.
    expect([...base].slice(0, 3)).toEqual([60, 30, 15])
  })

  it('brightens above the baseline and clamps rather than wrapping', () => {
    const base = px(200, 100, 50)
    applyShading(base, px(255, 255, 255))
    expect(base[1]).toBeGreaterThan(100)
    expect(base[0]).toBe(255)
  })

  it('leaves alpha alone, so the layer below still shows where the map is transparent', () => {
    const base = Uint8ClampedArray.from([120, 60, 30, 40])
    applyShading(base, px(255, 255, 255))
    expect(base[3]).toBe(40)
  })
})

describe('line emphasis', () => {
  /** Reads a width expression at one zoom, for both the selected and the unselected case. */
  const at = (expr: unknown, zoom: number): { plain: number; selected: number } => {
    // ['interpolate', ['linear'], ['zoom'], z0, caseExpr, z1, caseExpr] or a bare case expression.
    const branch = (e: unknown, sel: boolean): number =>
      Array.isArray(e) && e[0] === 'case' ? (sel ? (e[2] as number) : (e[3] as number)) : (e as number)
    if (!Array.isArray(expr) || expr[0] !== 'interpolate') {
      return { plain: branch(expr, false), selected: branch(expr, true) }
    }
    const stops: [number, unknown][] = []
    for (let i = 3; i < expr.length; i += 2) stops.push([expr[i] as number, expr[i + 1]])
    const [z0, e0] = stops[0]!
    const [z1, e1] = stops[stops.length - 1]!
    const t = Math.min(1, Math.max(0, (zoom - z0) / (z1 - z0)))
    const lerp = (sel: boolean) => branch(e0, sel) + (branch(e1, sel) - branch(e0, sel)) * t
    return { plain: lerp(false), selected: lerp(true) }
  }

  it('draws every line wider when emphasised, at every zoom the map reaches', () => {
    for (const zoom of [6, 9, 12, 15, 18]) {
      const plain = at(lineWidth(0), zoom)
      const loud = at(lineWidth(1), zoom)
      expect(loud.plain).toBeGreaterThan(plain.plain)
      expect(loud.selected).toBeGreaterThan(plain.selected)
    }
  })

  it('keeps the selected line the widest thing on the map, emphasised or not', () => {
    for (const zoom of [9, 12, 15]) {
      for (const emphasis of [0, 0.5, 1]) {
        const { plain, selected } = at(lineWidth(emphasis), zoom)
        expect(selected).toBeGreaterThan(plain)
      }
    }
  })

  it('helps most where a line is only a few pixels long', () => {
    // The whole point: at z15 a 400 m line already crosses the screen, at z9 it is a hairline.
    const boost = (zoom: number) => at(lineWidth(1), zoom).plain / at(lineWidth(0), zoom).plain
    expect(boost(9)).toBeGreaterThan(boost(15))
  })

  it('stops dimming the unselected lines as they swell, and dims them again as they settle', () => {
    const unselected = (e: number) => (lineOpacity(e) as [string, unknown, number, number])[3]
    expect(unselected(0)).toBeCloseTo(0.7)
    expect(unselected(0.5)).toBeCloseTo(0.85)
    expect(unselected(1)).toBeCloseTo(1)
  })

  it('grows smoothly rather than jumping, so a half-finished swell is half-way', () => {
    const width = (e: number) => at(lineWidth(e), 9).plain
    expect(width(0.5)).toBeGreaterThan(width(0))
    expect(width(0.5)).toBeLessThan(width(1))
  })
})

describe('ageText', () => {
  const now = Date.parse('2026-08-26T12:00:00Z')
  const ago = (ms: number) => ageText(new Date(now - ms).toISOString(), now)

  it('picks the unit that makes the number readable', () => {
    expect(ago(4 * 86_400_000)).toBe('4d ago')
    expect(ago(5 * 3_600_000)).toBe('5h ago')
    expect(ago(90_000)).toBe('2m ago')
  })

  it('never reads as in the future, for a region written moments ago', () => {
    expect(ago(-5000)).toBe('1m ago')
  })
})

describe('squareRing', () => {
  /** Distance between two drawn corners, back in the projection the square was defined in. */
  const apart = (a: [number, number], b: [number, number]) => {
    const [ae, an] = toUtm33(a[1], a[0])
    const [be, bn] = toUtm33(b[1], b[0])
    return Math.hypot(ae - be, an - bn)
  }
  // Western Brandenburg, where UTM convergence is worst and the old flat-earth box was 35 m out.
  const centre = (e: number, n: number) => toWgs84(e, n)

  it('makes neighbouring squares share an edge, so they tile', () => {
    const w = centre(400500, 5820500)
    const e = centre(401500, 5820500)
    const [a, b] = [squareRing(w.lat, w.lon, 1000), squareRing(e.lat, e.lon, 1000)]
    // Ring order is SW, SE, NE, NW: the west square's east edge is the east square's west edge.
    expect(apart(a[1]!, b[0]!)).toBeLessThan(0.5)
    expect(apart(a[2]!, b[3]!)).toBeLessThan(0.5)
  })

  it('is not axis-aligned in latitude and longitude', () => {
    // Exactly the assumption the old code made. A projected square is rotated by the convergence
    // angle, so its southern edge does not sit at one latitude.
    const c = centre(400500, 5820500)
    const ring = squareRing(c.lat, c.lon, 1000)
    expect(Math.abs(ring[0]![1] - ring[1]![1])).toBeGreaterThan(1e-4)
  })

  it('keeps the size it was asked for', () => {
    const c = centre(400500, 5820500)
    const ring = squareRing(c.lat, c.lon, 1000)
    expect(apart(ring[0]!, ring[1]!)).toBeCloseTo(1000, 0)
    expect(apart(ring[1]!, ring[2]!)).toBeCloseTo(1000, 0)
  })
})
