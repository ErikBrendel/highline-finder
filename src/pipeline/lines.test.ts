import { describe, expect, it } from 'vitest'
import { chooseHeights, dedupe, evaluateLine, findLines, refine } from './lines.js'
import { gridFrom } from './testing.js'
import { DEFAULT_PARAMS } from './params.js'
import type { Anchor } from './openness.js'
import type { Grid } from './raster.js'
import type { Params } from '../shared/types.js'

const p: Params = DEFAULT_PARAMS

/**
 * An anchor that is open in every direction, so tests exercise lines.ts in isolation. Ground
 * height is read from the grid rather than passed in, because evaluateLine treats the raster as
 * authoritative -- a fixture that disagreed with its own terrain would test nothing.
 */
function anchor(e: number, n: number, g: Grid): Anchor {
  const ground = g.nearest(e, n)
  return {
    e,
    n,
    ground,
    anchorMin: ground + p.aFrameMin,
    anchorMax: ground + p.aFrameMax,
    open: new Uint8Array(p.sectorCount).fill(1),
    openCount: p.sectorCount,
    // lines.ts never reads this; only the openness scan and the debug dump use it.
    dropDepth: p.minDropDepth,
  }
}

/** Plateaus at 50 m either side of a canyon floor at `floor`. */
const canyon = (floor: number) =>
  gridFrom(400, 400, (e) => (e <= 45 || e >= 255 ? 50 : floor))

const rimsOf = (g: Grid) => [anchor(40, 200, g), anchor(260, 200, g)]

/** Midspan sag the pipeline will apply to a span of this length. */
const sagOf = (length: number) => p.sagRatio * length

describe('findLines', () => {
  it('finds a line across a canyon and sags it by sagRatio at midspan', () => {
    const g = canyon(20)
    const { candidates } = findLines(rimsOf(g), g, g, p)
    expect(candidates).toHaveLength(1)
    const c = candidates[0]!
    expect(c.length).toBeCloseTo(220, 0)
    expect(c.sag).toBeCloseTo(sagOf(220), 2)
    expect(c.offLevel).toBe(0)

    const mid = c.profile.reduce((a, s) => (Math.abs(s.d - 110) < Math.abs(a.d - 110) ? s : a))
    expect(mid.line).toBeCloseTo(50 + p.aFrameMax - sagOf(220), 1)
    expect(c.canopyBlockedFraction).toBe(0)
  })

  it('reports exposure as the deepest air gap, which is at the rim rather than at midspan', () => {
    // The line is highest where it has only just left the anchor, so over a flat canyon floor
    // the biggest gap is the first sample past the edge, not the sagging middle.
    const g = canyon(20)
    const c = findLines(rimsOf(g), g, g, p).candidates[0]!
    const gaps = c.profile.map((s) => s.line - s.ground)
    expect(c.exposure).toBeCloseTo(Math.max(...gaps), 0)
    expect(Math.max(...gaps)).toBeGreaterThan(50 + p.aFrameMax - sagOf(220) - 20)
  })

  it('accepts a line even though clearance at the anchor is below minClearance', () => {
    // The line leaves the anchor at most aFrameMax up, which is under minClearance. Without the
    // anchorZone exclusion this candidate -- and every other -- would be rejected.
    const g = canyon(20)
    const c = findLines(rimsOf(g), g, g, p).candidates[0]!
    expect(c.profile[0]!.line - c.profile[0]!.ground).toBeLessThanOrEqual(p.aFrameMax)
    expect(p.aFrameMax).toBeLessThan(p.minClearance)
    expect(c.clearanceMin).toBeGreaterThanOrEqual(p.minClearance)
  })

  it('rejects a canyon too shallow for the sagging line to clear', () => {
    const g = canyon(48)
    expect(findLines(rimsOf(g), g, g, p).candidates).toHaveLength(0)
  })

  it('rejects a crossing that clears the ground but has too little air to be a highline', () => {
    // A shallow 8 m dip on a 100 m span: the line stays above the ground the whole way but never
    // gets more than ~10 m of air under it.
    const dip = gridFrom(300, 300, (e) => (e <= 100 || e >= 200 ? 50 : 42))
    const edges = [anchor(99.5, 150, dip), anchor(200.5, 150, dip)]
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
    const c = findLines(rimsOf(g), g, surface, p).candidates[0]!
    expect(c.canopyBlockedFraction).toBeGreaterThan(0.5)
    expect(c.canopyClearanceMin).toBeLessThan(0)
    expect(c.scoreParts.canopy).toBeLessThan(0.5)
  })

  it('collapses near-duplicate lines and keeps the best-scoring one', () => {
    const g = canyon(20)
    const crowd = [
      anchor(40, 200, g), anchor(40, 203, g), anchor(43, 200, g),
      anchor(260, 200, g), anchor(260, 203, g),
    ]
    const { candidates, pairsFeasible } = findLines(crowd, g, g, p)
    expect(pairsFeasible).toBeGreaterThan(1)
    expect(candidates).toHaveLength(1)
  })

  it('honours the length window', () => {
    const g = canyon(20)
    expect(findLines(rimsOf(g), g, g, { ...p, maxLength: 200 }).candidates).toHaveLength(0)
    expect(findLines(rimsOf(g), g, g, { ...p, minLength: 300 }).candidates).toHaveLength(0)
  })

  it('skips pairs whose sectors do not face each other', () => {
    const g = canyon(20)
    const blind = rimsOf(g).map((a) => ({
      ...a,
      open: new Uint8Array(p.sectorCount),
      openCount: 0,
    }))
    const r = findLines(blind, g, g, p)
    expect(r.pairsInRange).toBe(1)
    expect(r.pairsSectorPassed).toBe(0)
  })
})

describe('offlevel constraint', () => {
  // Rims 6 m apart in height. Raising the low end by aFrameMax is all the search can do, so this
  // much offlevel is unavoidable.
  const asym = gridFrom(400, 400, (e) => (e <= 45 ? 50 : e >= 255 ? 56 : 20))
  const rims = [anchor(40, 200, asym), anchor(260, 200, asym)]
  const unavoidable = 6 - p.aFrameMax
  const span = 220

  it('rejects a mismatched pair when the budget is too tight and accepts it when it is not', () => {
    const tight = { ...p, maxOffLevelRatio: (unavoidable - 1) / span }
    const loose = { ...p, maxOffLevelRatio: (unavoidable + 1) / span }
    expect(findLines(rims, asym, asym, tight).candidates).toHaveLength(0)
    const ok = findLines(rims, asym, asym, loose).candidates
    expect(ok).toHaveLength(1)
    expect(ok[0]!.offLevel).toBeCloseTo(unavoidable, 1)
  })

  it('never reports a candidate above the offlevel ratio', () => {
    const g = canyon(20)
    const mixed = [
      anchor(40, 200, g), anchor(40, 260, g), anchor(260, 200, g), anchor(260, 260, g),
    ]
    for (const c of findLines(mixed, g, g, p).candidates) {
      expect(c.offLevelRatio).toBeLessThanOrEqual(p.maxOffLevelRatio + 1e-9)
      expect(c.offLevel).toBeCloseTo(Math.abs(c.a.anchor - c.b.anchor), 2)
    }
  })
})

describe('refine', () => {
  // Rim A is a step: 50 m at n=197.5, rising to 54 m two metres north. Rim B is flat at 54 m, so
  // the starting pair is 4 m mismatched and a small move of A can level it out entirely.
  const ridge = gridFrom(400, 400, (e, n) =>
    e <= 45 ? (n >= 198.5 ? 54 : 50) : e >= 255 ? 54 : 20,
  )
  const start = evaluateLine({ e: 40, n: 197.5 }, { e: 260, n: 197.5 }, ridge, ridge, p)!

  it('moves an anchor onto a nearby higher rim to level the line out', () => {
    expect(start.offLevel).toBeCloseTo(4 - p.aFrameMax, 1)

    const r = refine([start], ridge, ridge, p)
    const c = r.candidates[0]!
    expect(r.improved).toBe(1)
    expect(c.score).toBeGreaterThan(start.score)
    expect(c.offLevel).toBe(0)
    expect(c.a.ground).toBeCloseTo(54, 1)
  })

  it('never moves an anchor further than refineRadius from where it started', () => {
    const g = canyon(20)
    const found = findLines(rimsOf(g), g, g, p).candidates
    // refine preserves input order, so found[i] is where candidate i started.
    refine(found, g, g, p).candidates.forEach((c, i) => {
      const orig = found[i]!
      expect(Math.hypot(c.a.e - orig.a.e, c.a.n - orig.a.n)).toBeLessThanOrEqual(p.refineRadius)
      expect(Math.hypot(c.b.e - orig.b.e, c.b.n - orig.b.n)).toBeLessThanOrEqual(p.refineRadius)
    })
  })

  it('is a no-op at radius 0', () => {
    const r = refine([start], ridge, ridge, { ...p, refineRadius: 0 })
    expect(r.candidates[0]).toBe(start)
    expect(r.improved).toBe(0)
    expect(r.evaluations).toBe(0)
  })

  it('never returns a worse score than it started with', () => {
    const g = canyon(20)
    const found = findLines(rimsOf(g), g, g, p).candidates
    const refined = refine(found, g, g, p).candidates
    refined.forEach((c, i) => expect(c.score).toBeGreaterThanOrEqual(found[i]!.score))
  })
})

describe('chooseHeights', () => {
  // A literal 2 m range at each end. chooseHeights takes its bounds explicitly and knows nothing
  // about params, so the arithmetic here is deliberately independent of aFrameMax.
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

describe('dedupe', () => {
  // Only e, n and score are read, so tests do not need whole candidates.
  const cand = (score: number, a: [number, number], b: [number, number]) =>
    ({ id: `${score}`, score, a: { e: a[0], n: a[1] }, b: { e: b[0], n: b[1] } }) as unknown as
      Parameters<typeof dedupe>[0][number]

  const A: [number, number] = [0, 0]
  const B: [number, number] = [300, 0]

  it('collapses lines whose both endpoints are close and keeps the best score', () => {
    const kept = dedupe([cand(50, A, B), cand(80, [3, 4], [302, 1]), cand(60, [1, 1], B)], 25)
    expect(kept).toHaveLength(1)
    expect(kept[0]!.score).toBe(80)
  })

  it('keeps lines that share only one endpoint', () => {
    // Same anchor A, far-apart B: a genuine fan of different lines, not duplicates.
    const kept = dedupe([cand(50, A, B), cand(60, A, [0, 300])], 25)
    expect(kept).toHaveLength(2)
  })

  it('matches endpoints regardless of which end is A', () => {
    const kept = dedupe([cand(50, A, B), cand(60, B, A)], 25)
    expect(kept).toHaveLength(1)
    expect(kept[0]!.score).toBe(60)
  })

  it('collapses nothing at radius 0 unless the endpoints coincide exactly', () => {
    expect(dedupe([cand(50, A, B), cand(60, [1, 0], B)], 0)).toHaveLength(2)
    expect(dedupe([cand(50, A, B), cand(60, A, B)], 0)).toHaveLength(1)
  })

  it('suppresses transitively via the kept line, not in chains', () => {
    // 30 m apart end to end: the middle one is within radius of the first, the last is not, so
    // greedy suppression in score order keeps two rather than collapsing the whole chain.
    const kept = dedupe(
      [cand(90, A, B), cand(80, [20, 0], [320, 0]), cand(70, [40, 0], [340, 0])],
      25,
    )
    expect(kept).toHaveLength(2)
    expect(kept.map((c) => c.score)).toEqual([90, 70])
  })
})
