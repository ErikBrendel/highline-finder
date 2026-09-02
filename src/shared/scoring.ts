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
  /**
   * Smallest gap between the line and the worst thing anywhere across the band, on the interior.
   *
   * The band, not the centreline: a line does not stay on its own axis, and a measurement that
   * assumed it did happily threaded corridors between buildings. See shared/profile.ts.
   *
   * A true gap in metres, and on its own it no longer says whether the line qualifies -- what a
   * sample is held to varies, less over water and more over a road. `clearanceMargin` is the figure
   * that answers that; this one is what a person reads.
   */
  clearanceMin: number
  /**
   * Smallest amount by which any sample beats what it is held to. Negative means the line fails.
   *
   * Separate from `clearanceMin` because the requirement is no longer one number: three metres over
   * a field, one over open water. Reporting only the gap would say a line one metre over a lake
   * clears less than one three metres over a hedge, when the first is fine and the second is not.
   */
  clearanceMargin: number
  /**
   * Where that margin was found, along the span, and what was required of it there.
   *
   * Carried because the margin on its own is a number nobody can act on. What a sample is held to
   * varies -- a metre over open water, three over anything else -- so "0.65 m short" says nothing
   * about whether the problem is the lake in the middle or the bank at the end, and the reader will
   * assume it is whatever looks tightest on the chart. For the line at
   * 434780.5_5805692.5__434572.5_5805869.5 those are different places and different answers: it
   * clears the water by 1.02 m and passes, and fails on land ten metres from its far anchor.
   *
   * NaN where nothing was measured, which is the same case that leaves the minima at infinity.
   */
  clearanceMarginAt: number
  clearanceMarginNeeded: number
  /**
   * Deepest air gap anywhere. Measured on the *centreline*, unlike the clearance: this answers how
   * high the line is, and what a walker is over is what is directly beneath them.
   */
  exposure: number
  /**
   * Canopy, measured on the centreline as well, and deliberately so. The surface model carries a
   * 21-month epoch mismatch and photogrammetric noise and is already only a score rather than a
   * gate; widening it would compound a soft measurement rather than sharpen a hard one. The band's
   * vegetation is drawn in the profile chart instead, where a person can judge it.
   */
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
   * How deep the line runs inside the ground *within* `anchorZone`, averaged and weighted toward
   * the far edge of the zone. 0 for a line that stays above ground there, which is most of them.
   *
   * The anchor zone exists because a line leaves its anchor at ground level and no clearance rule
   * can hold there. But "no clearance required" was being read as "nothing here matters", and a
   * line that ploughs through a hillock ten metres from its anchor is worse than one that does not
   * -- not disqualifying, since the terrain right by an anchor can be cleared or rigged around, but
   * not free either. Weighted toward the far edge because the anchor end of the zone is where the
   * line is *supposed* to be on the ground.
   */
  anchorZoneDeficit: number
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
  // Absent means the band said nothing the centreline did not, which is the whole of a run at
  // sideClearanceRatio 0 and most samples of a line over open ground.
  const band = sp.groundMax ?? sp.ground
  const needs = sp.needed
  let clearanceMin = Infinity
  let clearanceMargin = Infinity
  let clearanceMarginAt = NaN
  let clearanceMarginNeeded = NaN
  let exposure = -Infinity
  let canopyClearanceMin = Infinity
  let blocked = 0
  let samples = 0
  let deficit = 0
  let weight = 0
  let zoneDeficit = 0
  let zoneWeight = 0

  for (let i = 0; i <= last; i++) {
    const t = last > 0 ? i / last : 0
    const ground = sp.ground[i]!
    /**
     * A station with no elevation is skipped whole, weights and all.
     *
     * The pipeline never produces one -- it refuses a line it could not measure -- but the viewer
     * now draws a partially measured line rather than nothing, and that profile arrives here. Left
     * to fall through, a NaN quietly did the worst possible thing: every comparison against it is
     * false, so it never lowered `clearanceMin` and never counted as blocked, while still adding to
     * `samples` and to `weight` with a deficit of zero. An unsurveyed gap therefore read as a
     * stretch of perfectly clear air and *raised* the score. Skipping means the figures describe
     * the ground actually seen, and the caller counts what was not.
     */
    if (Number.isNaN(ground)) continue
    const line = r2(lineHeightAt(hA, hB, sag, t))
    if (line - ground > exposure) exposure = line - ground
    const d = r2(t * length)
    // Fraction of the way from the nearer anchor to midspan: 0 at the ends, 1 in the middle.
    const central = Math.min(d, length - d) / (length / 2)
    if (d < inner0 || d > inner1) {
      // Inside the anchor zone nothing is required, but being buried is still worth knowing about.
      // The same weighting as outside, which here reads as "how far from the anchor" -- and at the
      // anchor itself the band has no width and the line sits on its own ground, so it is zero.
      zoneDeficit += central * Math.max(0, band[i]! - line)
      zoneWeight += central
      continue
    }

    const clear = line - band[i]!
    if (clear < clearanceMin) clearanceMin = clear
    const need = needs?.[i] ?? p.minClearance
    if (clear - need < clearanceMargin) {
      clearanceMargin = clear - need
      clearanceMarginAt = d
      clearanceMarginNeeded = need
    }
    const canopyClear = line - (sp.surface[i] ?? ground)
    if (canopyClear < canopyClearanceMin) canopyClearanceMin = canopyClear
    if (canopyClear < 0) blocked++
    weight += central
    if (clear < need) deficit += central * (need - clear)
    samples++
  }

  if (samples === 0) return null

  /**
   * Road crossings, measured on their own terms.
   *
   * Probed at the two ends of the stretch the road is under the band for, and at the lowest point
   * of the line if that falls inside it -- rather than at whichever profile samples happen to land
   * there, because a residential street is narrower than the sample spacing and would otherwise be
   * checked nowhere. The line is a parabola, so its minimum over an interval is at one of exactly
   * those three places and the worst of them is the worst there is.
   *
   * A crossing on a bridge is owed its clearance to the deck, and the deck is in the surface model
   * rather than the terrain -- the terrain model is bare earth and runs straight under it.
   *
   * The carrier is the road's own height, sampled on the road when the crossing was found -- not the
   * profile under the line, which for a span leaving a roof with a street passing beside it would
   * measure the street's clearance down from the roof. Only where no elevation model was to hand
   * does it fall back to the centreline series.
   *
   * Note this is emphatically not the band maximum. What a road demands is owed to the road; a
   * building standing next to it is a clearance problem in its own right and is already counted as
   * one, and adding the two would charge a line twice for the same metres of air.
   */
  // Ranked on the shortfall including its sign, so the crossing reported is the tightest one rather
  // than the first: with a floor at zero every clear crossing looks equally clear.
  //
  // Where the line bottoms out, in fractions of span: the vertex of the parabola, which sits at
  // midspan for a level line and moves toward the lower anchor for an offlevel one.
  const vertex = sag > 0 ? 0.5 - (hB - hA) / (8 * sag) : 0.5
  let worstShort = -Infinity
  let worstCrossing = -1
  let worstClearance = Infinity
  for (let c = 0; c < crossings.length; c++) {
    const x = crossings[c]!
    const carrier = x.onBridge ? sp.surface : sp.ground
    const t0 = Math.min(1, Math.max(0, x.from / length))
    const t1 = Math.min(1, Math.max(0, x.to / length))
    let clear = Infinity
    for (const t of [t0, t1, Math.min(t1, Math.max(t0, vertex))]) {
      const under = x.carrier ?? seriesAt(carrier, t)
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
    clearanceMargin,
    clearanceMarginAt,
    clearanceMarginNeeded,
    exposure,
    canopyClearanceMin,
    canopyBlockedFraction: blocked / samples,
    clearanceDeficit: weight > 0 ? deficit / weight : 0,
    anchorZoneDeficit: zoneWeight > 0 ? zoneDeficit / zoneWeight : 0,
    crossingDeficit: Math.max(0, worstShort),
    worstCrossing,
    worstClearance,
  }
}

/**
 * Which hard constraint rejects a measured line, or null if none does.
 *
 * The single list of gates, so the search, the validity check and the diagnostics cannot drift
 * apart about what disqualifies a line. Named rather than boolean because the pipeline reports
 * where lines are dying and to what -- a filter you cannot see the cost of is a filter you cannot
 * tune, and the clearance ladder over traffic is a pile of judgement calls waiting for exactly that
 * evidence.
 */
export type Reject = 'clearance' | 'exposure' | 'crossing' | 'canopy'

export function rejectionOf(m: Metrics, p: Params): Reject | null {
  if (m.clearanceMargin < 0) return 'clearance'
  if (m.exposure < p.minExposure) return 'exposure'
  // A hard constraint, like terrain and unlike canopy: a line six metres over a Bundesstraße is not
  // something anyone rigs, and reporting it with a low score would be reporting it as a candidate.
  if (m.crossingDeficit > 0) return 'crossing'
  return m.canopyBlockedFraction > p.maxCanopyBlocked ? 'canopy' : null
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
  return m && !rejectionOf(m, p) ? m : null
}

/**
 * Which hard constraints a line fails, in words. Empty means it is a valid candidate.
 *
 * Split out from the measurement so the interactive planner can describe a line that does not
 * qualify instead of discarding it -- "why does this spot not work" is as useful an answer as a
 * list of spots that do.
 */
/**
 * `maxLength` is not among the faults, on purpose.
 *
 * It is a bound on the *search* -- how far apart two anchors may be for the pipeline to bother
 * enumerating the pair -- and not a statement about a line. A 600 m span is a harder rig and a
 * bigger commitment, and it is not a rule violation; the figures below describe it perfectly well.
 * No found candidate can exceed it anyway, since nothing longer is ever paired, so this only ever
 * fired at a line somebody placed by hand and it told them their own line was wrong for being long.
 * The sanity ceiling on a hand-placed span lives in planPoints.ts, where it belongs.
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
  if (m.clearanceMargin < 0) {
    /**
     * The shortfall, which is one place on the span, and not a clearance next to a requirement.
     *
     * It used to quote both, deriving the requirement as `clearanceMin - clearanceMargin`. Those
     * are two separate minima taken over the whole span and there is no reason they fall at the
     * same station: with a metre required over water and three over land, a span can take its
     * tightest gap at the water and its worst margin on the land, and subtracting them invents a
     * requirement of 1.24 m that applies nowhere -- printed unrounded, as
     * "under the 1.240000000000009 m minimum", which is how it was noticed.
     *
     * The margin is a single sample's fact and needs no arithmetic, so that is what is reported --
     * with where it was found and what was owed there, because the shortfall alone sends the reader
     * to whatever looks tightest on the chart, which is a different place as often as not.
     */
    const over = m.clearanceMarginNeeded === p.waterClearance ? 'water' : 'ground'
    const where = Number.isFinite(m.clearanceMarginAt)
      ? ` at ${m.clearanceMarginAt.toFixed(0)} m, where it owes ${m.clearanceMarginNeeded} m over ${over}`
      : ''
    out.push(
      m.clearanceMin < 0
        ? // A negative clearance is not a small one: the line is inside the hill, and saying so is
          // the whole answer.
          'intersects the ground'
        : `comes ${(-m.clearanceMargin).toFixed(2)} m short${where}`,
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
    // "Over" would be a lie for a road the span never crosses, and the distance is the reason it
    // counts at all -- the band is what puts it under the line.
    const where =
      worst.offset > 0
        ? `a ${worst.kind.replace(/_/g, ' ')} running ${worst.offset.toFixed(1)} m to the side at`
        : `a ${worst.kind.replace(/_/g, ' ')} at`
    out.push(
      `passes ${m.worstClearance.toFixed(1)} m over ${where} ` +
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
    over(p.minLength - length, p.minLength, PENALTY.length)
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
    /**
     * How comfortable the terrain clearance is, on both counts.
     *
     * The margin over what each sample is held to, discounted by how far the line runs inside the
     * ground close to the anchors. Both are the same question -- how much room the terrain leaves
     * -- so they share one component rather than adding a sixth with a weight taken off the others.
     * Multiplied rather than subtracted so a burial cannot push a clean line's margin below zero
     * and flatten the gradient the anchor optimiser walks down.
     */
    margin:
      clamp01(m.clearanceMargin / 10) *
      clamp01(1 - m.anchorZoneDeficit / Math.max(p.minClearance, 0.01)),
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
function withMetrics(c: Candidate, m: Metrics, sagRatio: number, p: Params): Candidate {
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

export function rescoreAtSag(c: Candidate, sagRatio: number, p: Params): Candidate | null {
  if (!c.profile) return sagRatio <= c.maxSagRatio + 1e-9 ? c : null

  const m = metricsAt(c.profile, c.length, c.a.anchor, c.b.anchor, sagRatio, p, c.crossings)
  return m ? withMetrics(c, m, sagRatio, p) : null
}

/**
 * The same measurement, for a line being looked at rather than filtered.
 *
 * The difference is the validity gate. `rescoreAtSag` answers "is this still a candidate", so a
 * line that fails one drops out and null is the right answer. This answers "what is this line",
 * where null is never right: what a viewer needs from a line that no longer clears the ground is
 * the figures saying so, which is exactly what it throws away.
 *
 * It matters because the viewer measures more finely than the search did -- a metre against four --
 * and the search's own margin can be a couple of centimetres. The line at
 * 434780.5_5805692.5__434572.5_5805869.5 clears the ground it crosses by 1.04 m where 1.00 m is
 * required over open water, and rebuilt at a metre it comes out fractionally under. Gated, that
 * returned null, the panel fell back to a candidate carrying no profile at all, and the chart sat
 * on "loading elevation" for ever with nothing in flight to explain it -- while dragging an anchor
 * a centimetre drew the profile instantly, because the planner has never applied the gate.
 */
export function rescoreForDisplay(
  c: Candidate,
  sagRatio: number,
  p: Params,
): { candidate: Candidate; violations: string[] } | null {
  if (!c.profile) return null
  const m = rawMetricsAt(c.profile, c.length, c.a.anchor, c.b.anchor, sagRatio, p, c.crossings)
  if (!m) return null
  return {
    candidate: withMetrics(c, m, sagRatio, p),
    violations: violationsOf(m, c.length, c.offLevel, p, c.crossings ?? []),
  }
}
