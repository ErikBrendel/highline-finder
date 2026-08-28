import { describe, expect, it } from 'vitest'
import { bestFirst, dedupe, evaluateLine, findLines, refine, terrainPairs } from './lines.js'
import { chunks } from './pool.js'
import { chooseHeights } from '../shared/scoring.js'
import { gridFrom } from './testing.js'
import { DEFAULT_PARAMS } from './params.js'
import { packAnchors, type Anchor } from './openness.js'
import type { Grid, Pos } from '../shared/grid.js'
import type { Candidate, Params } from '../shared/types.js'
import { unpackProfile } from '../shared/profile.js'

const p: Params = DEFAULT_PARAMS

/**
 * The terrain a line was judged on, with its derived fields back, as the browser sees it.
 *
 * The pipeline never stores a profile -- it is a hundred numbers a candidate that the viewer
 * rebuilds live and far more finely -- so a test that wants to look under a line evaluates the pair
 * again and reads what `evaluateLine` returns beside the candidate.
 */
function expand(a: Pos, b: Pos, g: Grid, surface: Grid = g) {
  const { line, profile } = evaluateLine(a, b, g, surface, p, {}, true)
  return unpackProfile(profile!, line!.length, line!.a.anchor, line!.b.anchor, p.sagRatio, p)
}

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

/**
 * A scene whose city model covers the west rim only. Anchors carry their own attachment range, so
 * the west anchor is built roof-flat too -- that is what the openness scan does with the same mask.
 */
const westRoof = { roofs: { covers: (e: number) => e < 150 } }

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

    const [rimA, rimB] = rimsOf(g)
    const samples = expand(rimA!, rimB!, g)
    const mid = samples.reduce((a, s) => (Math.abs(s.d - 110) < Math.abs(a.d - 110) ? s : a))
    expect(mid.line).toBeCloseTo(50 + p.aFrameMax - sagOf(220), 1)
    expect(c.canopyBlockedFraction).toBe(0)
  })

  it('reports exposure as the deepest air gap, which is at the rim rather than at midspan', () => {
    // The line is highest where it has only just left the anchor, so over a flat canyon floor
    // the biggest gap is the first sample past the edge, not the sagging middle.
    const g = canyon(20)
    const [rimA, rimB] = rimsOf(g)
    const c = findLines(rimsOf(g), g, g, p).candidates[0]!
    const gaps = expand(rimA!, rimB!, g).map((s) => s.line - s.ground)
    expect(c.exposure).toBeCloseTo(Math.max(...gaps), 0)
    expect(Math.max(...gaps)).toBeGreaterThan(50 + p.aFrameMax - sagOf(220) - 20)
  })

  it('accepts a line even though clearance at the anchor is below minClearance', () => {
    // The line leaves the anchor at most aFrameMax up, which is under minClearance. Without the
    // anchorZone exclusion this candidate -- and every other -- would be rejected.
    const g = canyon(20)
    const [rimA, rimB] = rimsOf(g)
    const c = findLines(rimsOf(g), g, g, p).candidates[0]!
    const first = expand(rimA!, rimB!, g)[0]!
    expect(first.line - first.ground).toBeLessThanOrEqual(p.aFrameMax)
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
    // A stand of trees over part of the canyon floor, reaching above the line's height there.
    const surface = gridFrom(400, 400, (e) => (e > 110 && e < 190 ? 50 : 0))
    const c = findLines(rimsOf(g), g, surface, p).candidates[0]!
    expect(c.canopyBlockedFraction).toBeGreaterThan(0.2)
    expect(c.canopyBlockedFraction).toBeLessThan(p.maxCanopyBlocked)
    expect(c.canopyClearanceMin).toBeLessThan(0)
    expect(c.scoreParts.canopy).toBeLessThan(0.8)
  })

  it('rejects a line that is inside the canopy for most of its span', () => {
    const g = canyon(20)
    // Trees the height of the rims across the whole floor: the line never leaves them.
    const surface = gridFrom(400, 400, () => 50)
    expect(findLines(rimsOf(g), g, surface, p).candidates).toHaveLength(0)
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

describe('roof anchors', () => {
  const g = canyon(20)

  it('classifies by both ends and rigs a roof flat, all the way through findLines', () => {
    const [west, east] = rimsOf(g)
    const roofed = { ...west!, anchorMin: west!.ground, anchorMax: west!.ground }
    const c = findLines([roofed, east!], g, g, p, westRoof).candidates[0]!
    expect(c.kind).toBe('mixed')
    expect(c.a.aFrame).toBe(0)
    // The east rim is open ground and the two rims are level, so it takes the height it likes.
    expect(c.b.aFrame).toBe(0)
    expect(findLines(rimsOf(g), g, g, p).candidates[0]!.kind).toBe('natural')
  })

  it('keeps the classification when refinement moves an anchor', () => {
    const start = evaluateLine({ e: 40, n: 200 }, { e: 260, n: 200 }, g, g, p, westRoof).line!
    expect(start.kind).toBe('mixed')
    const moved = refine([start], g, g, p, westRoof).candidates[0]!
    expect(moved.kind).toBe('mixed')
    expect(moved.a.aFrame).toBe(0)
  })
})

describe('band clearance', () => {
  // Pinned rather than taken from the default, so tuning the width does not turn these red.
  const p: Params = { ...DEFAULT_PARAMS, sideClearanceRatio: 0.04 }

  /**
   * The case the band exists for: two blocks with a corridor between them, and a line threaded
   * straight down it. On the centreline there is nothing but floor; three metres either side there
   * is fifty metres of building.
   */
  const corridor = (gap: number) =>
    gridFrom(400, 400, (e, n) =>
      e <= 45 || e >= 255 ? 50 : Math.abs(n - 200) <= gap / 2 ? 20 : 70,
    )

  it('rejects a line threading a corridor its centreline fits down', () => {
    const g = corridor(6)
    // The centreline runs 30 m over the floor for the whole span and sees nothing at all.
    const thin = { ...p, sideClearanceRatio: 0 }
    expect(evaluateLine({ e: 40, n: 200 }, { e: 260, n: 200 }, g, g, thin).line).not.toBeNull()

    const banded = evaluateLine({ e: 40, n: 200 }, { e: 260, n: 200 }, g, g, p)
    expect(banded.line).toBeNull()
    expect(banded.reject).toBe('clearance')
  })

  it('keeps the same line once the corridor is wider than the band', () => {
    // 8.8 m of half-width at midspan on a 220 m span, so a 30 m corridor is clear of it.
    const c = evaluateLine({ e: 40, n: 200 }, { e: 260, n: 200 }, corridor(30), corridor(30), p).line
    expect(c).not.toBeNull()
    expect(c!.clearanceMin).toBeGreaterThan(p.minClearance)
  })

  it('measures exposure on the centreline even where the band is blocked', () => {
    // What is beside the line does not change how high it is over what is beneath it.
    const g = corridor(6)
    const thin = evaluateLine({ e: 40, n: 200 }, { e: 260, n: 200 }, g, g, {
      ...p,
      sideClearanceRatio: 0,
    }).line!
    const forced = evaluateLine({ e: 40, n: 200 }, { e: 260, n: 200 }, g, g, {
      ...p,
      minClearance: -100,
    }).line!
    expect(forced.exposure).toBeCloseTo(thin.exposure, 1)
    expect(forced.clearanceMin).toBeLessThan(0)
  })
})

describe('water clearance', () => {
  /**
   * A canyon the line clears by 1.5 m at midspan: too close over ground, ample over water.
   *
   * The rims sit at 50 m and the line leaves them 1.5 m up, so a 220 m span sags 11 m to 40.5 m in
   * the middle -- which is the number the floor is placed against.
   */
  const shallow = gridFrom(400, 400, (e) => (e <= 45 || e >= 255 ? 50 : 39))
  const ends: [Pos, Pos] = [{ e: 40, n: 200 }, { e: 260, n: 200 }]
  const lake = (covers: (e: number, n: number) => boolean) => ({ water: { covers } })

  /**
   * Rejection is asserted on the verdict rather than on which gate reached it.
   *
   * The cheap terrain gate reads the water layer too, so for a line over dry ground it now catches
   * the failure before the profile gate does and reports 'terrain' rather than 'clearance'. Both
   * are the same answer, and pinning the test to one of them would be testing the funnel's shape.
   */
  const accepts = (scene: object) => evaluateLine(...ends, shallow, shallow, loose, scene).line

  const loose = { ...p, minExposure: 0 }

  it('rejects over ground and accepts the same line over water', () => {
    expect(accepts({})).toBeNull()
    expect(accepts(lake(() => true))).not.toBeNull()
  })

  it('holds the line to the ground figure over an island in that water', () => {
    // Water everywhere except a 40 m island across the middle of the span, which is where the line
    // is lowest. One dry sample is enough, and should be -- the contrast with the all-water case
    // above is what pins the island as the cause rather than anything else about the fixture.
    expect(accepts(lake((e: number) => e < 130 || e > 170))).toBeNull()
  })

  it('holds the line to the ground figure where the band reaches a bank', () => {
    // The centreline is over water for the whole span; the band is not. A walker swinging sideways
    // lands on the bank, so the bank is what the clearance is owed to -- and the cheap gate, which
    // only reads the centreline, lets this through for the band to catch.
    const narrow = evaluateLine(...ends, shallow, shallow, loose, {
      water: { covers: (_e: number, n: number) => Math.abs(n - 200) < 2 },
    })
    expect(narrow.reject).toBe('clearance')
    // Widen the channel past the band and the same line is fine again.
    expect(accepts(lake((_e: number, n: number) => Math.abs(n - 200) < 12))).not.toBeNull()
  })

  it('reports the real gap, not one adjusted for what it is over', () => {
    // 1.5 m of air is what there is, and what the panel has to say, even though it passes.
    expect(accepts(lake(() => true))!.clearanceMin).toBeCloseTo(1.5, 1)
  })
})

describe('refine', () => {
  // Rim A is a step: 50 m at n=197.5, rising to 54 m two metres north. Rim B is flat at 54 m, so
  // the starting pair is 4 m mismatched and a small move of A can level it out entirely.
  const ridge = gridFrom(400, 400, (e, n) =>
    e <= 45 ? (n >= 198.5 ? 54 : 50) : e >= 255 ? 54 : 20,
  )
  const start = evaluateLine({ e: 40, n: 197.5 }, { e: 260, n: 197.5 }, ridge, ridge, p).line!

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

describe('dedupe indexing', () => {
  /**
   * The original definition, kept as an oracle: every kept line compared against every other.
   *
   * It walks the candidates in the same order the real one does, since what is under test here is
   * the bucket index -- whether nine cells around an anchor really hold every line worth comparing
   * against -- and not which of two tied lines wins. That is `bestFirst`'s job and has its own test.
   */
  function bruteForce(cs: Candidate[], radius: number): Candidate[] {
    const r2 = radius * radius
    const near = (x: { e: number; n: number }, y: { e: number; n: number }) =>
      (x.e - y.e) ** 2 + (x.n - y.n) ** 2 <= r2
    const kept: Candidate[] = []
    for (const c of [...cs].sort(bestFirst)) {
      const dup = kept.some(
        (k) => (near(c.a, k.a) && near(c.b, k.b)) || (near(c.a, k.b) && near(c.b, k.a)),
      )
      if (!dup) kept.push(c)
    }
    return kept
  }

  it('keeps exactly what comparing everything against everything would keep', () => {
    // A deterministic spread of overlapping lines, dense enough that most are duplicates.
    const cs: Candidate[] = []
    let seed = 1
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
    for (let i = 0; i < 600; i++) {
      const ae = 1000 + Math.round(rnd() * 300)
      const an = 2000 + Math.round(rnd() * 300)
      const be = ae + 120 + Math.round(rnd() * 60)
      const bn = an + Math.round(rnd() * 60)
      cs.push({
        id: `c${i}`,
        kind: 'natural',
        a: { lat: 0, lon: 0, e: ae, n: an, ground: 0, anchor: 0, aFrame: 0 },
        b: { lat: 0, lon: 0, e: be, n: bn, ground: 0, anchor: 0, aFrame: 0 },
        length: 0, bearing: 0, sag: 0, offLevel: 0, offLevelRatio: 0,
        clearanceMin: 0, exposure: 0, canopyClearanceMin: 0, canopyBlockedFraction: 0,
        score: Math.round(rnd() * 1000) / 10,
        scoreParts: { exposure: 0, length: 0, canopy: 0, margin: 0, level: 0 },
        maxSagRatio: 0.1,
      })
    }
    for (const radius of [5, 25, 60]) {
      expect(dedupe(cs, radius).map((c) => c.id)).toEqual(bruteForce(cs, radius).map((c) => c.id))
    }
  })
})

describe('splitting the pair search', () => {
  /**
   * The property the worker pool rests on: every unordered pair has exactly one `i`, so ranges of
   * `i` partition the pairs. Splitting has to lose none, invent none, and -- because dedup breaks
   * ties on list order -- put them in the order an unsplit run would.
   */
  it('produces exactly the pairs an unsplit search would, in the same order', () => {
    const g = canyon(0)
    const anchors = [
      anchor(40, 180, g), anchor(40, 200, g), anchor(40, 220, g),
      anchor(260, 180, g), anchor(260, 200, g), anchor(260, 220, g),
    ]
    const table = packAnchors(anchors, p.sectorCount)
    const whole = terrainPairs(table, g, p)
    expect(whole.count).toBeGreaterThan(0)

    for (const parts of [2, 3, 6]) {
      const ranges = chunks(anchors.length, parts)
      const split = ranges.map(([from, to]) => terrainPairs(table, g, p, {}, { from, to }))
      expect([...split.flatMap((s) => [...s.pairs])]).toEqual([...whole.pairs])
      expect(split.reduce((s, x) => s + x.pairsInRange, 0)).toBe(whole.pairsInRange)
    }
  })
})

describe('dividing the pair search by ground', () => {
  /**
   * The property statewide coverage rests on. A run that owns a box of ground keeps anchors well
   * outside it, so a partner across the seam still exists to be found, and claims only the pairs
   * whose first anchor is its own. Boxes that tile the plane therefore tile the pairs: none lost at
   * a seam, none reported twice, whatever the boxes are.
   */
  const g = canyon(0)
  // In the order the scan emits them -- north ascending, east ascending within a row -- because
  // ownership reads the first anchor off the index rather than comparing coordinates.
  const anchors = [180, 200, 220].flatMap((n) => [anchor(40, n, g), anchor(260, n, g)])
  const table = packAnchors(anchors, p.sectorCount)
  const keysOf = (found: ReturnType<typeof terrainPairs>) =>
    Array.from({ length: found.count }, (_, k) => `${found.pairs[2 * k]}-${found.pairs[2 * k + 1]}`)

  // Seams laid exactly through the anchors, at e=260 and n=200, since a seam nobody stands on
  // cannot show whether the boxes share their edges or divide them.
  const QUARTERS = {
    sw: { minE: 0, maxE: 260, minN: 0, maxN: 200 },
    se: { minE: 260, maxE: 400, minN: 0, maxN: 200 },
    nw: { minE: 0, maxE: 260, minN: 200, maxN: 400 },
    ne: { minE: 260, maxE: 400, minN: 200, maxN: 400 },
  }
  const owned = (owns: (typeof QUARTERS)[keyof typeof QUARTERS]) =>
    keysOf(terrainPairs(table, g, p, {}, { owns }))

  it('claims every pair exactly once across boxes that tile the ground', () => {
    const whole = keysOf(terrainPairs(table, g, p))
    expect(whole.length).toBeGreaterThan(0)
    const claimed = Object.values(QUARTERS).flatMap(owned)
    expect(new Set(claimed).size).toBe(claimed.length)
    expect([...claimed].sort()).toEqual([...whole].sort())
  })

  it('gives a pair to the box holding its southern end, not its northern one', () => {
    // Anchors 2 and 3 are the two rims at n=200, either side of the e=260 seam.
    expect(owned(QUARTERS.nw)).toContain('2-3')
    expect(owned(QUARTERS.ne)).not.toContain('2-3')
  })

  it('still pairs with anchors outside the owned box', () => {
    // Every anchor the north-west quarter owns sits at e=40, so each of its pairs reaches 220 m
    // east into ground it does not own. Confining the search to the box would find nothing.
    const reaching = owned(QUARTERS.nw)
    expect(reaching.length).toBeGreaterThan(0)
    for (const k of reaching) expect(anchors[Number(k.split('-')[1])]!.e).toBe(260)
  })
})

describe('chunks', () => {
  it('covers everything once, contiguously and in order', () => {
    for (const [total, parts] of [[10, 3], [10, 1], [3, 10], [0, 4]] as const) {
      const ranges = chunks(total, parts)
      expect(ranges.flatMap(([from, to]) => Array.from({ length: to - from }, (_, i) => from + i)))
        .toEqual(Array.from({ length: total }, (_, i) => i))
    }
  })
})

describe('dedup order', () => {
  const at = (e: number, n: number, score: number): Candidate =>
    ({
      id: `${e.toFixed(1)}_${n.toFixed(1)}__${(e + 300).toFixed(1)}_${n.toFixed(1)}`,
      score,
      a: { e, n } as Candidate['a'],
      b: { e: e + 300, n } as Candidate['b'],
    }) as Candidate

  /**
   * The property the whole incremental plan rests on: dedup over a union has to be the same answer
   * however that union was assembled. It keeps the first of each near-identical group, so a tie
   * broken by list position made the survivor depend on the order the pieces arrived in.
   */
  it('keeps the same line however the candidates were pooled', () => {
    // Three lines within dedupRadius of each other, two of them tied on score.
    const group = [at(1000, 1000, 50), at(1010, 1000, 50), at(1005, 1000, 49)]
    const orders = [
      [0, 1, 2], [2, 1, 0], [1, 0, 2], [1, 2, 0],
    ].map((order) => dedupe(order.map((i) => group[i]!), 25).map((c) => c.id))
    expect(new Set(orders.map((o) => o.join('|'))).size).toBe(1)
    expect(orders[0]).toHaveLength(1)
  })

  it('still prefers the better line over a tie-break', () => {
    const worse = at(1000, 1000, 40)
    const better = at(1010, 1000, 60)
    expect(dedupe([worse, better], 25).map((c) => c.score)).toEqual([60])
    expect(dedupe([better, worse], 25).map((c) => c.score)).toEqual([60])
  })
})
