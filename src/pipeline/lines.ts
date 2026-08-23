import { Grid } from './raster.js'
import { bearingOf, oppositeBearing, sectorOf, toWgs84 } from '../shared/geo.js'
import type { Anchor } from './openness.js'
import type { Candidate, Params, ProfileSample, ScoreParts } from '../shared/types.js'

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
  a: Anchor,
  b: Anchor,
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
  a: Anchor,
  b: Anchor,
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
  candidates: Candidate[]
  pairsInRange: number
  pairsSectorPassed: number
  pairsLevelEnough: number
  pairsFeasible: number
  candidatesAfterDedup: number
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
  const r2 = (v: number) => Math.round(v * 100) / 100

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

      const h = chooseHeights(
        a.anchorMin,
        a.anchorMax,
        b.anchorMin,
        b.anchorMax,
        p.maxOffLevelRatio * length,
      )
      if (!h) continue
      pairsLevelEnough++

      const m = measure(a, b, h.hA, h.hB, length, ground, surface, p)
      if (!m) continue

      const { score, parts } = scoreOf(length, h.offLevel, m, p)
      const wa = toWgs84(a.e, a.n)
      const wb = toWgs84(b.e, b.n)
      feasible.push({
        id: `${a.e.toFixed(0)}_${a.n.toFixed(0)}__${b.e.toFixed(0)}_${b.n.toFixed(0)}`,
        a: { ...wa, e: a.e, n: a.n, ground: a.ground, anchor: r2(h.hA), aFrame: r2(h.hA - a.ground) },
        b: { ...wb, e: b.e, n: b.n, ground: b.ground, anchor: r2(h.hB), aFrame: r2(h.hB - b.ground) },
        length: Math.round(length * 10) / 10,
        bearing: Math.round((bearing * 180) / Math.PI * 10) / 10,
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
      })
    }
  }

  // A 5 m anchor grid produces dozens of near-identical lines across the same gap. Collapse by
  // quantised endpoint pair and keep the best, so the result list is distinct locations rather
  // than one location repeated.
  const best = new Map<string, Candidate>()
  for (const c of feasible) {
    const q = (v: number) => Math.round(v / p.dedupCell)
    const ka = `${q(c.a.e)},${q(c.a.n)}`
    const kb = `${q(c.b.e)},${q(c.b.n)}`
    const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`
    const prev = best.get(key)
    if (!prev || c.score > prev.score) best.set(key, c)
  }

  const candidates = [...best.values()].sort((x, y) => y.score - x.score)
  return {
    candidates: candidates.slice(0, p.maxCandidates),
    pairsInRange,
    pairsSectorPassed,
    pairsLevelEnough,
    pairsFeasible: feasible.length,
    candidatesAfterDedup: candidates.length,
  }
}
