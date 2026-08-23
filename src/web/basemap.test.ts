import { describe, expect, it } from 'vitest'
import { BASEMAPS, MIX_MAX, basemapOpacity, basemapVisible } from './MapView.js'

const n = BASEMAPS.length

describe('basemap cross-fade', () => {
  it('shows exactly one basemap at each whole position', () => {
    for (let stop = 0; stop <= MIX_MAX; stop++) {
      const shown = BASEMAPS.map((_, i) => i).filter((i) => basemapVisible(i, stop, n))
      expect(shown).toEqual([stop])
      expect(basemapOpacity(stop, stop)).toBe(1)
    }
  })

  it('blends the two adjacent basemaps in between', () => {
    const shown = BASEMAPS.map((_, i) => i).filter((i) => basemapVisible(i, 0.5, n))
    expect(shown).toEqual([0, 1])
    expect(basemapOpacity(1, 0.5)).toBeCloseTo(0.5)
    expect(basemapOpacity(0, 0.5)).toBe(1)
  })

  it('never lets the background show through', () => {
    for (let mix = 0; mix <= MIX_MAX; mix += 0.25) {
      const bottom = BASEMAPS.map((_, i) => i).filter((i) => basemapVisible(i, mix, n)).shift()!
      expect(basemapOpacity(bottom, mix)).toBe(1)
    }
  })

  it('hides layers a fully opaque layer already covers, so their tiles are not fetched', () => {
    // At the far end only OSM is drawn, even though the layers below it still exist.
    expect(basemapVisible(0, MIX_MAX, n)).toBe(false)
    expect(basemapVisible(1, MIX_MAX, n)).toBe(false)
    expect(basemapVisible(MIX_MAX, MIX_MAX, n)).toBe(true)
  })
})
