import type { Candidate, Params, ProfileSample, ScoreParts, StoredProfile } from './types.js'
import { unpackProfile } from './profile.js'

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
}

export function lineHeightAt(hA: number, hB: number, sag: number, t: number): number {
  return hA + (hB - hA) * t - 4 * sag * t * (1 - t)
}

/** Line height at every profile sample, for a given sag as a fraction of span. */
export function lineOverProfile(
  profile: ProfileSample[],
  length: number,
  hA: number,
  hB: number,
  sagRatio: number,
): number[] {
  const sag = sagRatio * length
  return profile.map((s) => lineHeightAt(hA, hB, sag, length > 0 ? s.d / length : 0))
}

/**
 * Clearance metrics over a profile, or null when the line fails a hard constraint.
 *
 * Clearance is only required on the interior of the span, outside `anchorZone` at each end. At an
 * anchor the line may sit at ground level, so a whole-span requirement would reject everything.
 * The ISA's own guidance points the same way: mount a few metres in from the edge rather than
 * walking straight off it.
 */
export function rawMetrics(
  profile: ProfileSample[],
  line: number[],
  length: number,
  p: Params,
): Metrics | null {
  const inner0 = p.anchorZone
  const inner1 = length - p.anchorZone
  let clearanceMin = Infinity
  let exposure = -Infinity
  let canopyClearanceMin = Infinity
  let blocked = 0
  let samples = 0

  for (let i = 0; i < profile.length; i++) {
    const s = profile[i]!
    const clear = line[i]! - s.ground
    if (clear > exposure) exposure = clear
    if (s.d < inner0 || s.d > inner1) continue

    if (clear < clearanceMin) clearanceMin = clear
    const canopyClear = line[i]! - s.surface
    if (canopyClear < canopyClearanceMin) canopyClearanceMin = canopyClear
    if (canopyClear < 0) blocked++
    samples++
  }

  if (samples === 0) return null
  return {
    clearanceMin,
    exposure,
    canopyClearanceMin,
    canopyBlockedFraction: blocked / samples,
  }
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
): string[] {
  const out: string[] = []
  if (length < p.minLength) out.push(`${length.toFixed(0)} m is under the ${p.minLength} m minimum`)
  if (length > p.maxLength) out.push(`${length.toFixed(0)} m is over the ${p.maxLength} m maximum`)
  if (m.clearanceMin < p.minClearance) {
    out.push(
      `clears the ground by only ${m.clearanceMin.toFixed(1)} m, under the ` +
        `${p.minClearance} m minimum`,
    )
  }
  if (m.exposure < p.minExposure) {
    out.push(
      `never more than ${m.exposure.toFixed(1)} m off the ground, under the ` +
        `${p.minExposure} m that makes it a highline`,
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

/** Measurement plus the validity gate, for the pipeline. Null when the line is not a candidate. */
export function metricsOf(
  profile: ProfileSample[],
  line: number[],
  length: number,
  p: Params,
): Metrics | null {
  const m = rawMetrics(profile, line, length, p)
  if (!m) return null
  return m.clearanceMin < p.minClearance || m.exposure < p.minExposure ? null : m
}

/**
 * 0-100. Weights are a judgement call, not a derivation, so the components are stored on every
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
      0.15 * parts.level)
  return { score, parts }
}

const r2 = (v: number) => Math.round(v * 100) / 100

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
): number {
  const feasible = (sag: number) => {
    const profile = unpackProfile(sp, length, hA, hB, sag)
    return metricsOf(profile, profile.map((s) => s.line), length, p) !== null
  }
  let lo = 0
  let hi = 0.25
  if (!feasible(lo)) return 0
  if (feasible(hi)) return hi
  for (let i = 0; i < 14; i++) {
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

  const profile = unpackProfile(c.profile, c.length, c.a.anchor, c.b.anchor, sagRatio)
  const m = metricsOf(profile, profile.map((s) => s.line), c.length, p)
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
