import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { toUtm33 } from '../shared/geo.js'
import { rescoreAtSag } from '../shared/scoring.js'
import type { Dataset } from '../shared/types.js'

/**
 * Integration check against the real pipeline output. Skipped when candidates.json has not been
 * generated, so a fresh clone or CI without cached rasters still passes `npm test`.
 *
 * These assertions are the ones that catch a silently wrong pipeline: unit tests on synthetic
 * canyons cannot tell you that the projection, the raster mosaic and the scoring agree on real
 * data, only that each works alone.
 */
const PATH = new URL('../web/public/candidates.json', import.meta.url).pathname
const present = existsSync(PATH)

describe.skipIf(!present)('generated candidates.json', () => {
  const data: Dataset = JSON.parse(readFileSync(PATH, 'utf8'))
  const { params, regions } = data.meta
  const aois = regions.flatMap((r) => r.aois)
  const inSomeAoi = (lat: number, lon: number) =>
    aois.some(
      (a) =>
        lat >= a.south - 1e-4 &&
        lat <= a.north + 1e-4 &&
        lon >= a.west - 1e-4 &&
        lon <= a.east + 1e-4,
    )

  it('produced candidates, over ground with real relief', () => {
    expect(data.candidates.length).toBeGreaterThan(0)
    expect(regions.length).toBeGreaterThan(0)
    for (const r of regions) expect(r.groundMax - r.groundMin).toBeGreaterThan(10)
  })

  it('respects every hard filter it claims to enforce', () => {
    for (const c of data.candidates) {
      expect(c.length).toBeGreaterThanOrEqual(params.minLength)
      expect(c.length).toBeLessThanOrEqual(params.maxLength)
      expect(c.clearanceMin).toBeGreaterThanOrEqual(params.minClearance)
      expect(c.exposure).toBeGreaterThanOrEqual(params.minExposure)
      expect(c.offLevelRatio).toBeLessThanOrEqual(params.maxOffLevelRatio + 1e-9)
      expect(c.offLevel).toBeCloseTo(Math.abs(c.a.anchor - c.b.anchor), 1)
    }
  })

  it('keeps anchor coordinates consistent between WGS84 and UTM, and inside an AOI', () => {
    for (const c of data.candidates.slice(0, 40)) {
      for (const a of [c.a, c.b]) {
        expect(a.aFrame).toBeGreaterThanOrEqual(params.aFrameMin - 1e-9)
        expect(a.aFrame).toBeLessThanOrEqual(params.aFrameMax + 1e-9)
        const [e, n] = toUtm33(a.lat, a.lon)
        expect(e).toBeCloseTo(a.e, 1)
        expect(n).toBeCloseTo(a.n, 1)
        expect(inSomeAoi(a.lat, a.lon)).toBe(true)
      }
    }
  })

  it('reports a length that matches the anchor separation', () => {
    for (const c of data.candidates.slice(0, 40)) {
      expect(Math.hypot(c.b.e - c.a.e, c.b.n - c.a.n)).toBeCloseTo(c.length, 0)
    }
  })

  it('has profiles that start at A, end at B, and never dip below the terrain', () => {
    for (const c of data.candidates.slice(0, 40)) {
      const first = c.profile[0]!
      const last = c.profile[c.profile.length - 1]!
      expect(first.d).toBe(0)
      expect(last.d).toBeCloseTo(c.length, 0)
      expect(first.line).toBeCloseTo(c.a.anchor, 0)
      expect(last.line).toBeCloseTo(c.b.anchor, 0)
      for (const s of c.profile) expect(s.surface).toBeGreaterThanOrEqual(s.ground)
    }
  })

  it('survives rescoring at its own generation sag without drift', () => {
    // The web app re-derives every clearance from the serialised profile. If the pipeline measured
    // from full-precision values while the app measures from rounded ones, candidates on a
    // constraint boundary vanish the moment the page loads.
    for (const c of data.candidates) {
      const same = rescoreAtSag(c, params.sagRatio, params)
      expect(same, `candidate ${c.id} rejected at its own sag`).not.toBeNull()
      expect(same!.score).toBe(c.score)
      expect(same!.clearanceMin).toBe(c.clearanceMin)
      expect(same!.exposure).toBe(c.exposure)
    }
  })

  it('only loses candidates as sag increases', () => {
    const alive = (pct: number) =>
      data.candidates.filter((c) => rescoreAtSag(c, pct, params) !== null).length
    expect(alive(params.sagRatio)).toBe(data.candidates.length)
    expect(alive(params.sagRatio * 1.4)).toBeLessThanOrEqual(alive(params.sagRatio))
  })

  it('is sorted by score and stays within the output cap', () => {
    const scores = data.candidates.map((c) => c.score)
    expect(scores).toEqual([...scores].sort((a, b) => b - a))
    expect(data.candidates.length).toBeLessThanOrEqual(params.maxCandidates)
  })
})
