import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { toUtm33 } from '../shared/geo.js'
import { rescoreAtSag } from '../shared/scoring.js'
import { boxOf, contains } from './regions.js'
import { LINE_KINDS } from '../shared/types.js'
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
// A file from a pipeline older than the three-list split reads as absent rather than as a failure,
// the same way a missing one does: this suite asserts on the current schema, not on whether the
// checkout happens to hold output from before it.
const loaded: Dataset | null = existsSync(PATH) ? JSON.parse(readFileSync(PATH, 'utf8')) : null
const present = !!loaded?.lines?.natural

/**
 * Derived up here, not inside the describe: vitest still runs a skipped suite's body to collect its
 * tests, so anything that touches the file has to be safe when there is no file to touch.
 */
const data: Dataset = loaded ?? ({ meta: { regions: [] }, lines: {} } as unknown as Dataset)
const { params, regions } = data.meta
/**
 * An AOI is given in latitude and longitude but searched as its UTM bounding box, which is a
 * slightly larger, skewed quadrilateral -- so an anchor near a corner can sit outside the
 * lat/lon rectangle and still be inside the area the search was asked to cover. The boxes are
 * what the pipeline actually confines anchors to, so they are what this checks.
 */
const boxes = regions.flatMap((r) => r.aois.map(boxOf))
const inSomeAoi = (e: number, n: number) => boxes.some((b) => contains(b, e, n))
// The file stores three lists; every rule below holds of a line whichever one it came out of.
const candidates = present
  ? LINE_KINDS.flatMap((kind) => data.lines[kind].map((c) => ({ ...c, kind })))
  : []

describe.skipIf(!present)('generated candidates.json', () => {
  it('produced candidates, over ground with real relief', () => {
    expect(candidates.length).toBeGreaterThan(0)
    expect(regions.length).toBeGreaterThan(0)
    // A region can be claimed on the map without having been searched -- see tools/seedRegion.ts --
    // and one of those knows no terrain range because it never loaded any. `anchorsScanned` is what
    // tells the two apart, since no real search of any area scans nothing.
    const searched = regions.filter((r) => r.anchorsScanned > 0)
    expect(searched.length).toBeGreaterThan(0)
    for (const r of searched) expect(r.groundMax - r.groundMin).toBeGreaterThan(10)
  })

  it('claims no lines for ground it never searched', () => {
    // The placeholder must stay distinguishable from a real empty answer: if a seeded region ever
    // carried candidates, something built them out of terrain that was never loaded.
    for (const r of regions.filter((x) => x.anchorsScanned === 0)) {
      expect(r.anchorsKept).toBe(0)
      const inRegion = candidates.filter((c) => r.aois.map(boxOf).some((b) => contains(b, c.a.e, c.a.n)))
      expect(inRegion).toHaveLength(0)
    }
  })

  it('respects every hard filter it claims to enforce', () => {
    for (const c of candidates) {
      expect(c.length).toBeGreaterThanOrEqual(params.minLength)
      expect(c.length).toBeLessThanOrEqual(params.maxLength)
      // The loosest figure any sample can earn, not the ordinary one: clearanceMin is the true gap
      // and a line over open water is held to less. Which samples were over water is not in the
      // dataset -- the gate itself lives in clearanceMargin, which is not stored -- so this is as
      // far as the file can be checked from the outside.
      expect(c.clearanceMin).toBeGreaterThanOrEqual(
        Math.min(params.minClearance, params.waterClearance),
      )
      expect(c.exposure).toBeGreaterThanOrEqual(params.minExposure)
      expect(c.canopyBlockedFraction).toBeLessThanOrEqual(params.maxCanopyBlocked + 1e-9)
      expect(c.offLevelRatio).toBeLessThanOrEqual(params.maxOffLevelRatio + 1e-9)
      expect(c.offLevel).toBeCloseTo(Math.abs(c.a.anchor - c.b.anchor), 1)
    }
  })

  it('keeps anchor coordinates consistent between WGS84 and UTM, and inside an AOI', () => {
    for (const c of candidates.slice(0, 40)) {
      for (const a of [c.a, c.b]) {
        expect(a.aFrame).toBeGreaterThanOrEqual(params.aFrameMin - 1e-9)
        expect(a.aFrame).toBeLessThanOrEqual(params.aFrameMax + 1e-9)
        const [e, n] = toUtm33(a.lat, a.lon)
        expect(e).toBeCloseTo(a.e, 1)
        expect(n).toBeCloseTo(a.n, 1)
        expect(inSomeAoi(a.e, a.n)).toBe(true)
      }
    }
  })

  it('reports a length that matches the anchor separation', () => {
    for (const c of candidates.slice(0, 40)) {
      expect(Math.hypot(c.b.e - c.a.e, c.b.n - c.a.n)).toBeCloseTo(c.length, 0)
    }
  })

  it('carries no profile, since the viewer measures the one line it opens', () => {
    // The reason candidates.json is a tenth of what it was. If one ever appears here, something has
    // started writing a hundred numbers per line into a file meant to hold millions of them.
    expect(candidates.filter((c) => c.profile)).toHaveLength(0)
  })

  it('survives rescoring at its own generation sag without drift', () => {
    // The web app re-derives every clearance from the serialised profile. If the pipeline measured
    // from full-precision values while the app measures from rounded ones, candidates on a
    // constraint boundary vanish the moment the page loads.
    for (const c of candidates) {
      const same = rescoreAtSag(c, params.sagRatio, params)
      expect(same, `candidate ${c.id} rejected at its own sag`).not.toBeNull()
      expect(same!.score).toBe(c.score)
      expect(same!.clearanceMin).toBe(c.clearanceMin)
      expect(same!.exposure).toBe(c.exposure)
    }
  })

  it('reports a max feasible sag consistent with its own validity', () => {
    for (const c of candidates) {
      expect(c.maxSagRatio).toBeGreaterThanOrEqual(params.sagRatio)
      // Just past that sag the line no longer clears, which is what the sag filter relies on.
      if (c.profile) expect(rescoreAtSag(c, c.maxSagRatio + 0.005, params)).toBeNull()
    }
  })

  it('only loses candidates as sag increases', () => {
    const alive = (pct: number) =>
      candidates.filter((c) => rescoreAtSag(c, pct, params) !== null).length
    expect(alive(params.sagRatio)).toBe(candidates.length)
    expect(alive(params.sagRatio * 1.4)).toBeLessThanOrEqual(alive(params.sagRatio))
  })

  it('is sorted by score within each list', () => {
    for (const kind of LINE_KINDS) {
      const scores = data.lines[kind].map((c) => c.score)
      expect(scores).toEqual([...scores].sort((a, b) => b - a))
    }
  })

  it('stores the kind as the list a line is in, and nowhere else', () => {
    const ids = new Set(candidates.map((c) => c.id))
    expect(ids.size).toBe(candidates.length)
    for (const kind of LINE_KINDS) {
      for (const c of data.lines[kind]) expect(c).not.toHaveProperty('kind')
    }
  })

  it('gives a roof anchor no A-frame', () => {
    // Not exactly zero: `aFrame` is the difference of an already-rounded attachment height and an
    // unrounded ground height, so a genuine zero can land a centimetre either side of it.
    const flat = (v: number) => expect(Math.abs(v)).toBeLessThanOrEqual(0.01)
    // Only urban and mixed lines can have a roof end, so this is also a check that the split is
    // real: if everything were filed as natural the assertions below would be vacuous.
    expect(data.lines.urban.length + data.lines.mixed.length).toBeGreaterThan(0)
    for (const c of data.lines.urban) {
      flat(c.a.aFrame)
      flat(c.b.aFrame)
    }
    for (const c of data.lines.mixed) {
      flat(Math.min(Math.abs(c.a.aFrame), Math.abs(c.b.aFrame)))
    }
  })
})
