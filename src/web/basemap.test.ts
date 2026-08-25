import { describe, expect, it } from 'vitest'
import { BLEND_STOPS, MIX_MAX, basemapOpacity, basemapVisible, stopAt } from './MapView.js'
import { SHADE_BASELINE, applyShading } from './shaded.js'

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
