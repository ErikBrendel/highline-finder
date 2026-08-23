import { Grid } from './raster.js'
import { bearingOf, oppositeBearing, sectorOf, toWgs84 } from '../shared/geo.js'
import type { Anchor } from './openness.js'
import type { AnchorOut, Candidate, Params, ProfileSample, ScoreParts } from '../shared/types.js'

/**
 * Stages 3-5: pair anchors, choose attachment heights, test the span, score and deduplicate.
 *
 * Offlevel. A line whose two ends sit at different heights is harder to rig, walks unevenly and
 * loads the lower anchor more, so the height difference is capped at `maxOffLevelRatio` of the
 * span -- 1 m over 50 m, 10 m over 500 m -- as a hard constraint. Without it the search happily
 * proposes lines tilted by tens of metres, which are geometrically fine and practically useless.
 *
 * Because an anchor has a *range* of usable attachment heights rather than one, the cap is not
 * simply a test on the terrain: see chooseHeights.
 *
 * Line geometry. The line is the chord between the two chosen attachment points, pulled down by a
 * parabolic sag with its maximum at midspan:
 *
 *     height(t) = lerp(hA, hB, t) - 4 * sag * t * (1 - t),   sag = sagRatio * length
 *
 * This is a stand-in, not a model. Real sag depends on webbing, tension and where the walker is
 * standing, and the worst case is not always midspan. A constant fraction of span is close
 * enough to rank candidates against each other and wrong enough that no rigging decision should
 * rest on it. See ROADMAP for the catenary replacement.
 *
 * Clearance is measured only on the interior of the span, outside `anchorZone` at each end. At an
 * anchor the line may sit at ground level, so a whole-span requirement would reject everything.
 *
 * Terrain is a hard filter, canopy is only scored. That is a deliberate project decision: bare
 * terrain clearance is geometry and is trustworthy, whereas the canopy layer carries a 21-month
 * epoch mismatch and photogrammetric noise, and vegetation can be worked around in ways terrain
 * cannot. The consequence is that a long result list is not a list of walkable lines -- in closed
 * forest most candidates will have a high canopyBlockedFraction. That column is the real filter,
 * and the score weights it accordingly.
 */

/** A candidate anchor position in EPSG:25833. */
export interface Pos {
  e: number
  n: number
}

export interface HeightChoice {
  hA: number
  hB: number
  offLevel: number
}

/**
 * Picks where the line attaches at each end, given the range each anchor allows and how much
 * offlevel the span can afford.
 *
 * Rule: get as level as possible first, then as high as possible. If the two ranges overlap at
 * all, a dead-level line exists, and it is rigged at the top of the overlap. Only when the ranges
 * are disjoint is any offlevel unavoidable, and then the minimum is the gap between them --
 * reject if that exceeds the budget.
 *
 * Levelness wins over height deliberately. Giving up a metre of attachment height costs almost
 * nothing when a candidate already has 20 m of air underneath, whereas offlevel is a real rigging
 * problem at any scale. Maximising height first would have the search choose an offlevel line and
 * then get marked down for it by its own score.
 *
 * This is what makes the anchor range worth modelling: two rims 1.5 m apart in ground height can
 * still give a perfectly level line, because one end goes on an A-frame and the other does not.
 */
export function chooseHeights(
  loA: number,
  hiA: number,
  loB: number,
  hiB: number,
  budget: number,
): HeightChoice | null {
  const lo = Math.max(loA, loB)
  const hi = Math.min(hiA, hiB)
  if (lo <= hi) return { hA: hi, hB: hi, offLevel: 0 }

  const offLevel = loA > hiB ? loA - hiB : loB - hiA
  if (offLevel > budget) return null
  return loA > hiB
    ? { hA: loA, hB: hiB, offLevel }
    : { hA: hiA, hB: loB, offLevel }
}

interface Metrics {
  clearanceMin: number
  exposure: number
  canopyClearanceMin: number
  canopyBlockedFraction: number
}

function lineHeight(hA: number, hB: number, sag: number, t: number): number {
  return hA + (hB - hA) * t - 4 * sag * t * (1 - t)
}

/**
 * Walks the span and returns clearance metrics, or null as soon as the terrain requirement is
 * violated. Returning early matters: most pairs fail, and the midspan check alone kills the bulk
 * of them before any real work happens.
 */
function measure(
  a: Pos,
  b: Pos,
  hA: number,
  hB: number,
  length: number,
  ground: Grid,
  surface: Grid,
  p: Params,
): Metrics | null {
  const sag = p.sagRatio * length
  const de = (b.e - a.e) / length
  const dn = (b.n - a.n) / length
  const inner0 = p.anchorZone
  const inner1 = length - p.anchorZone
  if (inner1 <= inner0) return null

  // Cheap reject first: the deepest sag sits at midspan, so that is where a line most often
  // meets the ground.
  const mid = length / 2
  if (lineHeight(hA, hB, sag, 0.5) - ground.sample(a.e + de * mid, a.n + dn * mid) < p.minClearance) {
    return null
  }

  let clearanceMin = Infinity
  let exposure = -Infinity
  let canopyClearanceMin = Infinity
  let blocked = 0
  let samples = 0

  for (let d = 0; d <= length; d += p.profileStep) {
    const e = a.e + de * d
    const n = a.n + dn * d
    const g = ground.sample(e, n)
    if (Number.isNaN(g)) return null
    const h = lineHeight(hA, hB, sag, d / length)
    const clear = h - g
    if (clear > exposure) exposure = clear

    if (d < inner0 || d > inner1) continue
    if (clear < p.minClearance) return null
    if (clear < clearanceMin) clearanceMin = clear

    const s = Math.max(g, surface.sample(e, n) || g)
    const canopyClear = h - s
    if (canopyClear < canopyClearanceMin) canopyClearanceMin = canopyClear
    if (canopyClear < 0) blocked++
    samples++
  }

  if (samples === 0 || exposure < p.minExposure) return null
  return {
    clearanceMin,
    exposure,
    canopyClearanceMin,
    canopyBlockedFraction: blocked / samples,
  }
}

/**
 * 0-100. Weights are a judgement call, not a derivation, so the components are stored on every
 * candidate for the UI to show.
 *
 * Exposure is scaled logarithmically between 5 m and 200 m. Linear scaling would pin every
 * genuinely big line at maximum and lose the difference between 40 m and 400 m of air, and there
 * is deliberately no upper cut-off -- a deeper gap is simply better.
 *
 * Levelness is scored as well as constrained: everything reaching this point is already within
 * the offlevel budget, but a dead-level line is still nicer than one at the limit.
 */
function scoreOf(length: number, offLevel: number, m: Metrics, p: Params): {
  score: number
  parts: ScoreParts
} {
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
  const budget = p.maxOffLevelRatio * length
  const parts: ScoreParts = {
    exposure: clamp01(Math.log10(Math.max(m.exposure, 1) / 5) / Math.log10(200 / 5)),
    length: clamp01(length / p.maxLength),
    canopy: 1 - m.canopyBlockedFraction,
    margin: clamp01((m.clearanceMin - p.minClearance) / 10),
    level: budget > 0 ? clamp01(1 - offLevel / budget) : 1,
  }
  const score =
    100 *
    (0.3 * parts.exposure +
      0.15 * parts.length +
      0.35 * parts.canopy +
      0.05 * parts.margin +
      0.15 * parts.level)
  return { score, parts }
}

function buildProfile(
  a: Pos,
  b: Pos,
  hA: number,
  hB: number,
  length: number,
  ground: Grid,
  surface: Grid,
  p: Params,
): ProfileSample[] {
  const sag = p.sagRatio * length
  const de = (b.e - a.e) / length
  const dn = (b.n - a.n) / length
  const steps = Math.min(p.profilePoints, Math.max(8, Math.round(length / p.profileStep)))
  const out: ProfileSample[] = []
  const r2 = (v: number) => Math.round(v * 100) / 100
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const d = t * length
    const e = a.e + de * d
    const n = a.n + dn * d
    const g = ground.sample(e, n)
    out.push({
      d: r2(d),
      ground: r2(g),
      surface: r2(Math.max(g, surface.sample(e, n) || g)),
      line: r2(lineHeight(hA, hB, sag, t)),
    })
  }
  return out
}

export interface FindResult {
  /** Deduplicated but not capped; run.ts refines and caps. */
  candidates: Candidate[]
  pairsInRange: number
  pairsSectorPassed: number
  pairsLevelEnough: number
  pairsFeasible: number
  candidatesAfterDedup: number
}

/**
 * Builds the full candidate for a pair of positions, or null if it fails any hard constraint.
 *
 * Positions are free-floating rather than taken from the anchor lattice, because the refinement
 * pass moves them off it. Terrain heights come from the grid rather than from the Anchor records
 * for the same reason: this is the single place that decides what a line at two coordinates is
 * worth, so the search and the refinement cannot drift apart.
 *
 * Anchor ground heights are read from the containing cell, not interpolated. Anchors sit at cliff
 * edges by their nature, and interpolating there averages the rim with the drop beside it and puts
 * the anchor metres below where it really is. The profile between them does interpolate, since
 * there the point is a smooth section rather than one specific spot.
 */
export function evaluateLine(
  a: Pos,
  b: Pos,
  ground: Grid,
  surface: Grid,
  p: Params,
): Candidate | null {
  const gA = ground.nearest(a.e, a.n)
  const gB = ground.nearest(b.e, b.n)
  if (Number.isNaN(gA) || Number.isNaN(gB)) return null

  const dE = b.e - a.e
  const dN = b.n - a.n
  const length = Math.hypot(dE, dN)
  if (length < p.minLength || length > p.maxLength) return null

  const h = chooseHeights(
    gA + p.aFrameMin,
    gA + p.aFrameMax,
    gB + p.aFrameMin,
    gB + p.aFrameMax,
    p.maxOffLevelRatio * length,
  )
  if (!h) return null

  const m = measure(a, b, h.hA, h.hB, length, ground, surface, p)
  if (!m) return null

  const r2 = (v: number) => Math.round(v * 100) / 100
  const { score, parts } = scoreOf(length, h.offLevel, m, p)
  const bearing = bearingOf(dE, dN)
  const wa = toWgs84(a.e, a.n)
  const wb = toWgs84(b.e, b.n)
  return {
    id: `${a.e.toFixed(1)}_${a.n.toFixed(1)}__${b.e.toFixed(1)}_${b.n.toFixed(1)}`,
    a: { ...wa, e: a.e, n: a.n, ground: r2(gA), anchor: r2(h.hA), aFrame: r2(h.hA - gA) },
    b: { ...wb, e: b.e, n: b.n, ground: r2(gB), anchor: r2(h.hB), aFrame: r2(h.hB - gB) },
    length: Math.round(length * 10) / 10,
    bearing: Math.round(((bearing * 180) / Math.PI) * 10) / 10,
    sag: r2(p.sagRatio * length),
    offLevel: r2(h.offLevel),
    offLevelRatio: Math.round((h.offLevel / length) * 10000) / 10000,
    clearanceMin: r2(m.clearanceMin),
    exposure: r2(m.exposure),
    canopyClearanceMin: r2(m.canopyClearanceMin),
    canopyBlockedFraction: Math.round(m.canopyBlockedFraction * 1000) / 1000,
    score: Math.round(score * 10) / 10,
    scoreParts: parts,
    profile: buildProfile(a, b, h.hA, h.hB, length, ground, surface, p),
  }
}

export function findLines(
  anchors: Anchor[],
  ground: Grid,
  surface: Grid,
  p: Params,
): FindResult {
  let pairsInRange = 0
  let pairsSectorPassed = 0
  let pairsLevelEnough = 0
  const feasible: Candidate[] = []

  // Plain double loop. At this AOI size that is ~2e6 iterations of a sector lookup, which is
  // nothing; a uniform grid index only becomes necessary for regional runs (see ROADMAP).
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i]!
    for (let j = i + 1; j < anchors.length; j++) {
      const b = anchors[j]!
      const dE = b.e - a.e
      const dN = b.n - a.n
      const length = Math.hypot(dE, dN)
      if (length < p.minLength || length > p.maxLength) continue
      pairsInRange++

      const bearing = bearingOf(dE, dN)
      if (!a.open[sectorOf(bearing, p.sectorCount)]) continue
      if (!b.open[sectorOf(oppositeBearing(bearing), p.sectorCount)]) continue
      pairsSectorPassed++

      // Cheap pre-check on the same rule evaluateLine will apply, so the offlevel funnel stays
      // observable in the logs instead of hiding inside the profile rejection count.
      if (
        !chooseHeights(
          a.anchorMin,
          a.anchorMax,
          b.anchorMin,
          b.anchorMax,
          p.maxOffLevelRatio * length,
        )
      ) {
        continue
      }
      pairsLevelEnough++

      const c = evaluateLine(a, b, ground, surface, p)
      if (c) feasible.push(c)
    }
  }

  const candidates = dedupe(feasible, p.dedupRadius)
  return {
    candidates,
    pairsInRange,
    pairsSectorPassed,
    pairsLevelEnough,
    pairsFeasible: feasible.length,
    candidatesAfterDedup: candidates.length,
  }
}

/** Offsets within `radius`, on a `step` lattice, ordered outward. Excludes the origin. */
function neighbourhood(radius: number, step: number): Pos[] {
  const out: Pos[] = []
  const k = Math.floor(radius / step)
  for (let i = -k; i <= k; i++) {
    for (let j = -k; j <= k; j++) {
      const e = i * step
      const n = j * step
      if ((e === 0 && n === 0) || e * e + n * n > radius * radius) continue
      out.push({ e, n })
    }
  }
  return out.sort((x, y) => x.e * x.e + x.n * x.n - (y.e * y.e + y.n * y.n))
}

export interface RefineResult {
  candidates: Candidate[]
  improved: number
  totalGain: number
  evaluations: number
}

/**
 * Hill-climbs each candidate's two anchors to a local score maximum.
 *
 * The anchor lattice is `anchorStep` metres coarse, so every reported anchor can be up to half a
 * step away from the position that actually works best. This pass recovers that: each end is moved
 * independently over a `refineStep` lattice, capped at `refineRadius` from where it started, and
 * the pair of positions with the best score wins. A radius of at least half `anchorStep` is what
 * makes the original quantisation stop mattering.
 *
 * Coordinate descent -- move A to its best position with B fixed, then B with A fixed, repeat --
 * because the two ends interact: raising one end changes the offlevel budget and hence the height
 * the other end may use. Displacement is always measured from the *original* position, so the caps
 * hold no matter how many passes run and the search cannot drift away across iterations.
 *
 * Runs after deduplication rather than before, on hundreds of candidates instead of tens of
 * thousands. Refining everything first would be more thorough and roughly a hundred times slower.
 */
export function refine(
  candidates: Candidate[],
  ground: Grid,
  surface: Grid,
  p: Params,
): RefineResult {
  if (p.refineRadius <= 0) {
    return { candidates, improved: 0, totalGain: 0, evaluations: 0 }
  }
  const offsets = neighbourhood(p.refineRadius, p.refineStep)
  let improved = 0
  let totalGain = 0
  let evaluations = 0

  const out = candidates.map((start) => {
    const origin = [
      { e: start.a.e, n: start.a.n },
      { e: start.b.e, n: start.b.n },
    ] as const
    let best = start

    for (let pass = 0; pass < p.refineIterations; pass++) {
      const before = best.score

      for (const end of [0, 1] as const) {
        const fixed = end === 0 ? { e: best.b.e, n: best.b.n } : { e: best.a.e, n: best.a.n }
        for (const off of offsets) {
          const moved = { e: origin[end].e + off.e, n: origin[end].n + off.n }
          const c = end === 0
            ? evaluateLine(moved, fixed, ground, surface, p)
            : evaluateLine(fixed, moved, ground, surface, p)
          evaluations++
          if (c && c.score > best.score) best = c
        }
      }

      if (best.score <= before) break
    }

    if (best !== start) {
      improved++
      totalGain += best.score - start.score
    }
    return best
  })

  return { candidates: out, improved, totalGain, evaluations }
}

/**
 * Collapses near-identical lines, keeping the best-scoring one.
 *
 * Two candidates are the same line when *both* endpoints are within `radius` of each other, in
 * either orientation -- sharing only one endpoint makes them genuinely different lines fanning out
 * from a common anchor, which is worth seeing.
 *
 * Greedy suppression in score order rather than quantising endpoints onto a grid. Grid cells are
 * cheaper but have a boundary artefact: two anchors a metre apart on opposite sides of a cell edge
 * land in different buckets and both survive, which is exactly the duplicate this is meant to
 * remove. Note that `radius` interacts with `anchorStep`: at or below the anchor spacing it only
 * catches immediate lattice neighbours, so it has to be a multiple of it to thin results out.
 */
export function dedupe(candidates: Candidate[], radius: number): Candidate[] {
  const r2 = radius * radius
  const near = (p: AnchorOut, q: AnchorOut) =>
    (p.e - q.e) ** 2 + (p.n - q.n) ** 2 <= r2

  const kept: Candidate[] = []
  for (const c of [...candidates].sort((x, y) => y.score - x.score)) {
    const duplicate = kept.some(
      (k) =>
        (near(c.a, k.a) && near(c.b, k.b)) || (near(c.a, k.b) && near(c.b, k.a)),
    )
    if (!duplicate) kept.push(c)
  }
  return kept
}
