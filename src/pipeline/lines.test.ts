import { describe, expect, it } from 'vitest'
import { chooseHeights, findLines } from './lines.js'
import { gridFrom } from './testing.js'
import { DEFAULT_PARAMS } from './params.js'
import type { Anchor } from './openness.js'
import type { Params } from '../shared/types.js'

const p: Params = DEFAULT_PARAMS

/** An anchor that is open in every direction, so tests exercise lines.ts in isolation. */
function anchor(e: number, n: number, ground: number): Anchor {
  return {
    e,
    n,
    ground,
    anchorMin: ground + p.aFrameMin,
    anchorMax: ground + p.aFrameMax,
    open: new Uint8Array(p.sectorCount).fill(1),
    openCount: p.sectorCount,
  }
}

/** Plateaus at 50 m either side of a canyon floor at `floor`. */
const canyon = (floor: number) =>
  gridFrom(400, 400, (e) => (e <= 45 || e >= 255 ? 50 : floor))

describe('findLines', () => {
  const rims = [anchor(40, 200, 50), anchor(260, 200, 50)]

  it('finds a line across a canyon and sags it by sagRatio at midspan', () => {
    const g = canyon(20)
    const { candidates } = findLines(rims, g, g, p)
    expect(candidates).toHaveLength(1)
    const c = candidates[0]!
    expect(c.length).toBeCloseTo(220, 0)
    expect(c.sag).toBeCloseTo(8.8, 2)

    const mid = c.profile.reduce((a, s) => (Math.abs(s.d - 110) < Math.abs(a.d - 110) ? s : a))
    expect(mid.line).toBeCloseTo(52 - 8.8, 1)
    expect(c.offLevel).toBe(0)
    expect(c.canopyBlockedFraction).toBe(0)
  })

  it('reports exposure as the deepest air gap, which is at the rim rather than at midspan', () => {
    // The line is highest where it has only just left the anchor, so over a flat canyon floor
    // the biggest gap is the first sample past the edge, not the sagging middle.
    const g = canyon(20)
    const c = findLines(rims, g, g, p).candidates[0]!
    // The serialised profile is resampled to profilePoints, coarser than the profileStep the
    // metrics were measured at, so the two agree only to within a sample.
    const gaps = c.profile.map((s) => s.line - s.ground)
    expect(c.exposure).toBeCloseTo(Math.max(...gaps), 0)
    expect(c.exposure).toBeGreaterThan(52 - 8.8 - 20)
    const midGap = 52 - 8.8 - 20
    expect(Math.max(...gaps)).toBeGreaterThan(midGap)
  })

  it('accepts a line even though clearance at the anchor is below minClearance', () => {
    // The line leaves the anchor at most aFrameMax up, which is under minClearance. Without the
    // anchorZone exclusion this candidate -- and every other -- would be rejected.
    const g = canyon(20)
    const c = findLines(rims, g, g, p).candidates[0]!
    expect(c.profile[0]!.line - c.profile[0]!.ground).toBeLessThanOrEqual(p.aFrameMax)
    expect(p.aFrameMax).toBeLessThan(p.minClearance)
    expect(c.clearanceMin).toBeGreaterThanOrEqual(p.minClearance)
  })

  it('rejects a canyon too shallow for the sagging line to clear', () => {
    // Floor at 48 sits above the midspan height of 43.2.
    expect(findLines(rims, canyon(48), canyon(48), p).candidates).toHaveLength(0)
  })

  it('rejects a crossing that clears the ground but has too little air to be a highline', () => {
    // A shallow 8 m dip on a 100 m span: the line stays above the ground the whole way but
    // never gets more than ~10 m of air under it.
    const dip = gridFrom(300, 300, (e) => (e <= 100 || e >= 200 ? 50 : 42))
    const edges = [anchor(100, 150, 50), anchor(200, 150, 50)]
    const relaxed = findLines(edges, dip, dip, { ...p, minExposure: 0 }).candidates
    expect(relaxed).toHaveLength(1)
    expect(relaxed[0]!.clearanceMin).toBeGreaterThanOrEqual(p.minClearance)
    expect(relaxed[0]!.exposure).toBeLessThan(p.minExposure)
    expect(findLines(edges, dip, dip, p).candidates).toHaveLength(0)
  })

  it('scores canopy the line passes through without rejecting it', () => {
    const g = canyon(20)
    // 30 m of trees on the canyon floor, whose tops reach above the line's midspan height.
    const surface = gridFrom(400, 400, () => 50)
    const c = findLines(rims, g, surface, p).candidates[0]!
    expect(c.canopyBlockedFraction).toBeGreaterThan(0.5)
    expect(c.canopyClearanceMin).toBeLessThan(0)
    expect(c.scoreParts.canopy).toBeLessThan(0.5)
  })

  it('collapses near-duplicate lines and keeps the best-scoring one', () => {
    const g = canyon(20)
    const crowd = [
      anchor(40, 200, 50), anchor(40, 203, 50), anchor(43, 200, 50),
      anchor(260, 200, 50), anchor(260, 203, 50),
    ]
    const { candidates, pairsFeasible } = findLines(crowd, g, g, p)
    expect(pairsFeasible).toBeGreaterThan(1)
    expect(candidates).toHaveLength(1)
  })

  it('honours the length window', () => {
    const g = canyon(20)
    expect(findLines(rims, g, g, { ...p, maxLength: 200 }).candidates).toHaveLength(0)
    expect(findLines(rims, g, g, { ...p, minLength: 300 }).candidates).toHaveLength(0)
  })

  it('skips pairs whose sectors do not face each other', () => {
    const blind = rims.map((a) => ({ ...a, open: new Uint8Array(p.sectorCount), openCount: 0 }))
    const g = canyon(20)
    const r = findLines(blind, g, g, p)
    expect(r.pairsInRange).toBe(1)
    expect(r.pairsSectorPassed).toBe(0)
  })
})

describe('chooseHeights', () => {
  // Ranges are ground height plus aFrameMin..aFrameMax, so a 2 m range at each end.
  const range = (ground: number): [number, number] => [ground, ground + 2]

  it('levels two rims of unequal height by raising only the lower one', () => {
    const [loA, hiA] = range(50)
    const [loB, hiB] = range(51.5)
    const h = chooseHeights(loA, hiA, loB, hiB, 2)!
    expect(h.offLevel).toBe(0)
    expect(h.hA).toBe(h.hB)
    // Level at the top of the overlap: A goes on a full A-frame, B barely leaves the ground.
    expect(h.hA).toBe(52)
  })

  it('prefers a level line over a higher offlevel one even when the budget allows it', () => {
    const h = chooseHeights(50, 52, 51.5, 53.5, 2)!
    expect(h.offLevel).toBe(0)
    expect(h.hB).toBeLessThan(53.5)
  })

  it('accepts the minimum unavoidable offlevel when the ranges do not overlap', () => {
    // Rims 3 m apart: the ranges 50..52 and 53..55 are disjoint by 1 m.
    const h = chooseHeights(50, 52, 53, 55, 2)!
    expect(h.offLevel).toBeCloseTo(1)
    expect(h.hA).toBe(52)
    expect(h.hB).toBe(53)
  })

  it('rejects a pair whose closest achievable heights still exceed the budget', () => {
    expect(chooseHeights(50, 52, 60, 62, 2)).toBeNull()
  })
})

describe('offlevel constraint', () => {
  const g = canyon(20)

  it('rejects a pair too mismatched for the span, and accepts it on a longer one', () => {
    // 6 m of ground mismatch leaves 4 m of unavoidable offlevel once both ranges are used.
    const short = [anchor(40, 200, 50), anchor(160, 200, 56)]
    const long = [anchor(40, 200, 50), anchor(260, 200, 56)]
    // Budgets: 120 m -> 2.4 m (too tight), 220 m -> 4.4 m (enough).
    expect(findLines(short, g, g, p).candidates).toHaveLength(0)
    const ok = findLines(long, g, g, p).candidates
    expect(ok).toHaveLength(1)
    expect(ok[0]!.offLevel).toBeCloseTo(4, 1)
  })

  it('never reports a candidate above the offlevel ratio', () => {
    const mixed = [
      anchor(40, 200, 50), anchor(40, 260, 53), anchor(260, 200, 50), anchor(260, 260, 55),
    ]
    for (const c of findLines(mixed, g, g, p).candidates) {
      expect(c.offLevelRatio).toBeLessThanOrEqual(p.maxOffLevelRatio + 1e-9)
      expect(c.offLevel).toBeCloseTo(Math.abs(c.a.anchor - c.b.anchor), 2)
    }
  })
})
