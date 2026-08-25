import { requiredOver } from './roads.js'
import type { Candidate, Crossing, Params, ScoreParts, StoredProfile } from './types.js'

/**
 * Sag geometry, clearance metrics and scoring, shared by the pipeline and the web app.
 *
 * This lives in shared/ because the web app re-derives all of it at a user-chosen sag. Everything
 * needed is already in the stored profile: `ground` and `surface` per sample, plus the two
 * attachment heights, which give the chord. So the line at any sag is recoverable without the
 * raster, and no extra data has to be serialised for the sag control to work.
 *
 * The pipeline reports metrics computed by these same functions over the profile it emits, rather
 * than from its own finer raster walk. That costs a little resolution and buys exact agreement
 * between what the pipeline wrote and what the UI recomputes -- without it the two disagree by a
 * sample's worth of terrain and the numbers beside the chart contradict the chart.
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
 * Rule: get as level as possible first, then as high as possible. If the two ranges overlap at all,
 * a dead-level line exists, and it is rigged at the top of the overlap. Only when the ranges are
 * disjoint is any offlevel unavoidable, and then the minimum is the gap between them -- reject if
 * that exceeds the budget.
 *
 * Levelness wins over height deliberately. Giving up a metre of attachment height costs almost
 * nothing when a candidate already has 20 m of air underneath, whereas offlevel is a real rigging
 * problem at any scale. Maximising height first would have the search choose an offlevel line and
 * then get marked down for it by its own score.
 *
 * Pass Infinity as the budget to ask what the best achievable heights are regardless of the cap,
 * which is what the interactive planner wants: it reports the offlevel rather than refusing.
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
  return loA > hiB ? { hA: loA, hB: hiB, offLevel } : { hA: hiA, hB: loB, offLevel }
}

export interface Metrics {
  clearanceMin: number
  exposure: number
  canopyClearanceMin: number
  canopyBlockedFraction: number
  /**
   * How badly the line fails the clearance rule, in metres, averaged over the interior and
   * weighted toward midspan. Zero for anything that passes, so it costs a valid candidate nothing.
   *
   * `clearanceMin` alone is a single worst sample: it cannot tell a line grazing one boulder from
   * one buried in a hillside for two hundred metres, and it does not care whether the offending
   * ground is next to an anchor or right where the walker would be. Both differences matter to a
   * person, and -- more to the point -- the search has no gradient to follow without them, so an
   * anchor sitting inside a building has nothing telling it which way is out.
   */
  clearanceDeficit: number
  /**
   * Metres the worst road crossing is short of what it demands, 0 when every crossing is clear.
   *
   * The worst rather than the sum: a crossing is one place, and a line is stopped by the one it
   * cannot clear, exactly as `clearanceMin` is a single worst sample.
   *
   * Deliberately not weighted toward midspan, unlike `clearanceDeficit`. The centrality weighting
   * exists because ground beside an anchor is ground the walker is not going to fall onto; a road
   * beside an anchor is a road, and `anchorZone` does not apply to it.
   */
  crossingDeficit: number
  /** Which crossing that shortfall belongs to, as an index, or -1. */
  worstCrossing: number
  /** Clearance the line actually had over that crossing. */
  worstClearance: number
}

/**
 * A stored series read at an arbitrary fraction along the span.
 *
 * Crossings land wherever the road happens to be, not on a profile sample: at 120 points a 500 m
 * line samples every 4.2 m, so a six-metre street can fall entirely between two of them.
 */
function seriesAt(series: number[], t: number): number {
  const last = series.length - 1
  if (last <= 0) return series[0] ?? NaN
  const x = Math.min(last, Math.max(0, t * last))
  const i = Math.floor(x)
  const f = x - i
  return f === 0 ? series[i]! : series[i]! * (1 - f) + series[Math.min(last, i + 1)]! * f
}

export function lineHeightAt(hA: number, hB: number, sag: number, t: number): number {
  return hA + (hB - hA) * t - 4 * sag * t * (1 - t)
}

const r2 = (v: number) => Math.round(v * 100) / 100

/**
 * Clearance metrics read straight off a stored profile, without materialising it.
 *
 * The single implementation, because it is on the hot path twice over: every feasible line is
 * measured once for its own metrics and about sixteen more times while bisecting for the loosest
 * sag it survives. Expanding the profile into objects for each of those was 61% of the scoring
 * stage -- two million lines times sixteen expansions is thirty-two million allocations of a
 * hundred and twenty-one objects, to read each one once and throw it away.
 *
 * Sample distance and line height are rounded exactly as unpackProfile rounds them, so this agrees
 * with what a materialised profile would have given down to the last decimal rather than
 * approximately. A test holds the two together.
 */
export function rawMetricsAt(
  sp: StoredProfile,
  length: number,
  hA: number,
  hB: number,
  sagRatio: number,
  p: Params,
  /** What the line passes over that carries traffic. Empty means nothing but ground and canopy. */
  crossings: Crossing[] = [],
): Metrics | null {
  const last = sp.ground.length - 1
  const sag = sagRatio * length
  const inner0 = p.anchorZone
  const inner1 = length - p.anchorZone
  let clearanceMin = Infinity
  let exposure = -Infinity
  let canopyClearanceMin = Infinity
  let blocked = 0
  let samples = 0
  let deficit = 0
  let weight = 0

  for (let i = 0; i <= last; i++) {
    const t = last > 0 ? i / last : 0
    const ground = sp.ground[i]!
    const line = r2(lineHeightAt(hA, hB, sag, t))
    const clear = line - ground
    if (clear > exposure) exposure = clear
    const d = r2(t * length)
    if (d < inner0 || d > inner1) continue

    if (clear < clearanceMin) clearanceMin = clear
    const canopyClear = line - (sp.surface[i] ?? ground)
    if (canopyClear < canopyClearanceMin) canopyClearanceMin = canopyClear
    if (canopyClear < 0) blocked++
    // Fraction of the way from the nearer anchor to midspan: 0 at the ends, 1 in the middle.
    const central = Math.min(d, length - d) / (length / 2)
    weight += central
    if (clear < p.minClearance) deficit += central * (p.minClearance - clear)
    samples++
  }

  if (samples === 0) return null

  /**
   * Road crossings, measured on their own terms.
   *
   * Three probes per crossing -- the centreline and both kerbs -- rather than whichever profile
   * samples happen to fall inside it, because a residential street is narrower than the sample
   * spacing and would otherwise be checked nowhere. The line is a smooth parabola and the ground
   * under a carriageway is close to flat, so three points find the worst of it.
   *
   * A crossing on a bridge is owed its clearance to the deck, and the deck is in the surface model
   * rather than the terrain -- the terrain model is bare earth and runs straight under it.
   */
  // Ranked on the shortfall including its sign, so the crossing reported is the tightest one rather
  // than the first: with a floor at zero every clear crossing looks equally clear.
  let worstShort = -Infinity
  let worstCrossing = -1
  let worstClearance = Infinity
  for (let c = 0; c < crossings.length; c++) {
    const x = crossings[c]!
    const carrier = x.onBridge ? sp.surface : sp.ground
    let clear = Infinity
    for (const at of [x.d - x.half, x.d, x.d + x.half]) {
      const t = Math.min(1, Math.max(0, at / length))
      const under = seriesAt(carrier, t)
      if (Number.isNaN(under)) continue
      const gap = r2(lineHeightAt(hA, hB, sag, t)) - under
      if (gap < clear) clear = gap
    }
    if (!Number.isFinite(clear)) continue
    const short = requiredOver(x, p) - clear
    if (short > worstShort) {
      worstShort = short
      worstCrossing = c
      worstClearance = clear
    }
  }

  return {
    clearanceMin,
    exposure,
    canopyClearanceMin,
    canopyBlockedFraction: blocked / samples,
    clearanceDeficit: weight > 0 ? deficit / weight : 0,
    crossingDeficit: Math.max(0, worstShort),
    worstCrossing,
    worstClearance,
  }
}

/** The same, plus the validity gate. Null when the line is not a candidate. */
export function metricsAt(
  sp: StoredProfile,
  length: number,
  hA: number,
  hB: number,
  sagRatio: number,
  p: Params,
  crossings: Crossing[] = [],
): Metrics | null {
  const m = rawMetricsAt(sp, length, hA, hB, sagRatio, p, crossings)
  if (!m) return null
  if (m.clearanceMin < p.minClearance || m.exposure < p.minExposure) return null
  // A hard constraint, like terrain and unlike canopy: a line six metres over a Bundesstraße is not
  // something anyone rigs, and reporting it with a low score would be reporting it as a candidate.
  if (m.crossingDeficit > 0) return null
  return m.canopyBlockedFraction > p.maxCanopyBlocked ? null : m
}

/**
 * Which hard constraints a line fails, in words. Empty means it is a valid candidate.
 *
 * Split out from the measurement so the interactive planner can describe a line that does not
 * qualify instead of discarding it -- "why does this spot not work" is as useful an answer as a
 * list of spots that do.
 */
export function violationsOf(
  m: Metrics,
  length: number,
  offLevel: number,
  p: Params,
  crossings: Crossing[] = [],
): string[] {
  const out: string[] = []
  if (length < p.minLength) out.push(`${length.toFixed(0)} m is under the ${p.minLength} m minimum`)
  if (length > p.maxLength) out.push(`${length.toFixed(0)} m is over the ${p.maxLength} m maximum`)
  if (m.clearanceMin < p.minClearance) {
    // A negative clearance is not a small one. "Clears the ground by only -2.6 m" is arithmetic
    // rather than a description: the line is inside the hill, and saying so is the whole answer.
    out.push(
      m.clearanceMin < 0
        ? 'intersects the ground'
        : `clears the ground by only ${m.clearanceMin.toFixed(1)} m, under the ` +
          `${p.minClearance} m minimum`,
    )
  }
  if (m.exposure < p.minExposure) {
    out.push(
      `never more than ${m.exposure.toFixed(1)} m off the ground, under the ` +
        `${p.minExposure} m that makes it a highline`,
    )
  }
  if (m.canopyBlockedFraction > p.maxCanopyBlocked) {
    out.push(
      `inside canopy for ${(m.canopyBlockedFraction * 100).toFixed(0)} % of the span, over the ` +
        `${(p.maxCanopyBlocked * 100).toFixed(0)} % that still counts as a line`,
    )
  }
  const worst = crossings[m.worstCrossing]
  if (worst && m.crossingDeficit > 0) {
    out.push(
      `passes ${m.worstClearance.toFixed(1)} m over a ${worst.kind.replace(/_/g, ' ')} at ` +
        `${worst.d.toFixed(0)} m, under the ${requiredOver(worst, p).toFixed(0)} m it needs`,
    )
  }
  const budget = p.maxOffLevelRatio * length
  if (offLevel > budget) {
    out.push(
      `offlevel by ${offLevel.toFixed(1)} m, over the ${budget.toFixed(1)} m allowed at this span`,
    )
  }
  return out
}

/**
 * Score points charged for one whole limit's worth of overshoot on each hard constraint.
 *
 * Judgement calls, like the score weights. Clearance is the heaviest because it is the one a
 * misplaced anchor is usually failing and the one the search can actually walk out of; the rest
 * are there so nothing that disqualifies a line is invisible in its score.
 */
const PENALTY = {
  clearance: 40,
  exposure: 20,
  canopy: 20,
  level: 20,
  length: 20,
  /** Per metre the rig is raised past what an A-frame reaches. Applied by the planner, see plan.ts. */
  rig: 20,
  /**
   * A road crossing that is too low, charged on the same scale as terrain clearance: a metre short
   * is a metre short, whichever of the two it is short of.
   */
  crossing: 40,
} as const

/**
 * How many score points a line's hard-constraint failures cost it. Zero for a valid candidate,
 * which is why adding this changed nothing about the pipeline's output.
 *
 * Each term is the overshoot measured against its own limit, so the number reads as "limits' worth
 * of wrongness", and each grows without bound -- deeper into a hillside is always worse, and there
 * is no plateau for the search to get lost on. The point of it being continuous is exactly that:
 * counting broken rules gives a step function with no downhill direction, so an anchor placed
 * inside a building had nothing to tell it which way to walk. Every entry the planner lists under
 * "would not qualify" has a term here.
 *
 * Allocation-free and on the pipeline's hot path -- roughly two million calls a run, all of them
 * returning zero.
 */
export function penaltyOf(m: Metrics, length: number, offLevel: number, p: Params): number {
  const over = (excess: number, limit: number, weight: number) =>
    excess > 0 && limit > 0 ? (weight * excess) / limit : 0

  const budget = p.maxOffLevelRatio * length
  return (
    over(m.clearanceDeficit, p.minClearance, PENALTY.clearance) +
    over(m.crossingDeficit, p.minClearance, PENALTY.crossing) +
    over(p.minExposure - m.exposure, p.minExposure, PENALTY.exposure) +
    over(m.canopyBlockedFraction - p.maxCanopyBlocked, 1 - p.maxCanopyBlocked, PENALTY.canopy) +
    over(offLevel - budget, budget, PENALTY.level) +
    over(p.minLength - length, p.minLength, PENALTY.length) +
    over(length - p.maxLength, p.maxLength, PENALTY.length)
  )
}

/** How high one end is rigged, against how high that anchor allows. See rigRange in anchoring.ts. */
export interface RigEnd {
  aFrame: number
  max: number
}

/** Points charged for rigging higher than the anchor allows, which no anchor move can fix. */
export function rigPenalty(a: RigEnd, b: RigEnd): number {
  const over = (e: RigEnd) => Math.max(0, e.aFrame - e.max)
  return PENALTY.rig * (over(a) + over(b))
}

/**
 * 0-100 for a valid line, and as far below zero as its failures deserve for one that is not.
 * Weights are a judgement call, not a derivation, so the components are stored on every
 * candidate for the UI to show.
 *
 * Exposure is scaled logarithmically between 5 m and 200 m. Linear scaling would pin every
 * genuinely big line at maximum and lose the difference between 40 m and 400 m of air, and there
 * is deliberately no upper cut-off -- a deeper gap is simply better.
 *
 * Levelness is scored as well as constrained: everything reaching this point is already within the
 * offlevel budget, but a dead-level line is still nicer than one at the limit.
 */
export function scoreOf(
  length: number,
  offLevel: number,
  m: Metrics,
  p: Params,
): { score: number; parts: ScoreParts } {
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
        0.15 * parts.level) -
    penaltyOf(m, length, offLevel, p)
  return { score, parts }
}

/**
 * Loosest sag at which a line still clears the terrain, as a fraction of span.
 *
 * Both gates degrade monotonically in sag -- more sag lowers the line at every interior point, so
 * clearance and exposure only shrink -- which makes a bisection exact to the tolerance rather than
 * a sample of the space.
 *
 * This is what lets the sag control filter a dataset with no stored profiles: one number per line
 * answers "is this still valid" for every line at once, where the metrics themselves need the
 * profile and are only wanted for the line actually being looked at.
 */
export function maxFeasibleSag(
  sp: StoredProfile,
  length: number,
  hA: number,
  hB: number,
  p: Params,
  crossings: Crossing[] = [],
): number {
  const feasible = (sag: number) => metricsAt(sp, length, hA, hB, sag, p, crossings) !== null
  let lo = 0
  let hi = 0.25
  if (!feasible(lo)) return 0
  if (feasible(hi)) return hi
  // 12 halvings of a 0.25 range lands inside 1e-4, which is the precision the result is stored at.
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2
    if (feasible(mid)) lo = mid
    else hi = mid
  }
  return Math.round(lo * 10000) / 10000
}

/**
 * Re-derives a candidate at a different sag, or null if it stops being feasible.
 *
 * Only tightening is meaningful. Candidates the pipeline rejected are not in the dataset at all,
 * so lowering the sag below the one used for generation cannot bring them back, and would report
 * an incomplete result as if it were complete.
 *
 * Without a stored profile the validity question is still answered exactly, from `maxSagRatio`, but
 * the metrics cannot be recomputed and are left at the values they were generated with. The browser
 * fetches a profile for whichever line is opened and rescores that one properly.
 */
export function rescoreAtSag(c: Candidate, sagRatio: number, p: Params): Candidate | null {
  if (!c.profile) return sagRatio <= c.maxSagRatio + 1e-9 ? c : null

  const m = metricsAt(c.profile, c.length, c.a.anchor, c.b.anchor, sagRatio, p, c.crossings)
  if (!m) return null

  const { score, parts } = scoreOf(c.length, c.offLevel, m, p)
  return {
    ...c,
    sag: r2(sagRatio * c.length),
    clearanceMin: r2(m.clearanceMin),
    exposure: r2(m.exposure),
    canopyClearanceMin: r2(m.canopyClearanceMin),
    canopyBlockedFraction: Math.round(m.canopyBlockedFraction * 1000) / 1000,
    score: Math.round(score * 10) / 10,
    scoreParts: parts,
  }
}
