import type { Pos, Sampler } from './grid.js'
import { buildProfile, packProfile } from './profile.js'
import {
  chooseHeights,
  maxFeasibleSag,
  penaltyOf,
  rawMetricsAt,
  rigPenalty,
  scoreOf,
  violationsOf,
  type Metrics,
  type RigEnd,
} from './scoring.js'
import { lineKind, rigRange } from './anchoring.js'
import type { Scene } from './scene.js'
import type { Candidate, Params } from './types.js'
import { toWgs84 } from './geo.js'

/** Id a planned line carries, so callers can distinguish it from a found candidate. */
export const PLANNED_ID = 'custom'

/**
 * Highest rig height the planner offers, a little above what the search allows.
 *
 * The search rigs off the ground with an A-frame, capped at `aFrameMax`. The planner reaches
 * slightly past that so a taller frame or a low anchor point can be tried by hand; anything over
 * `aFrameMax` is reported as a violation rather than silently accepted.
 */
export const PLANNED_RIG_MAX = 2

/** Attachment heights above ground at each end, when the user sets them by hand. */
export interface RigHeights {
  a: number
  b: number
}

export interface PlannedLine {
  candidate: Candidate
  /** Hard constraints this line fails. Empty means the search would have accepted it. */
  violations: string[]
  /**
   * Score points those failures cost, already subtracted from `candidate.score`. 0 when there are
   * none, and the two always agree: no violation is free and nothing else is charged for.
   */
  penalty: number
}

/**
 * A height to stand an anchor on when the survey has not covered the ground under it.
 *
 * Without one there is no span to draw at all: the whole line's elevation hangs off its two
 * attachment heights, so a single unmeasured anchor used to mean an empty chart -- which is most of
 * the time an anchor is being dragged, since dragging is the act of moving it somewhere new.
 *
 * Three guesses, in order of how much they are worth:
 *
 *   - One end measured: the other copies it, which draws the span level. A level line is the one
 *     assumption that adds nothing of its own -- any other offset would be inventing a slope.
 *   - Neither end measured: the mean of whatever ground the span does cross, so the line sits in
 *     the terrain that is on screen rather than above or below all of it.
 *   - Nothing measured anywhere: zero, and the span floats over an empty chart. Honest enough,
 *     since there is nothing for it to be wrong about.
 *
 * The guess reaches the chart and nothing else. `Candidate.a.ground` keeps the measured value, NaN
 * and all, so every figure derived from the anchor reads as unknown instead of as a survey reading.
 */
const GROUND_SCAN = 32

function standOn(a: Pos, b: Pos, gA: number, gB: number, ground: Sampler): [number, number] {
  if (!Number.isNaN(gA)) return [gA, gA]
  if (!Number.isNaN(gB)) return [gB, gB]
  let sum = 0
  let seen = 0
  for (let i = 0; i <= GROUND_SCAN; i++) {
    const t = i / GROUND_SCAN
    const v = ground.sample(a.e + (b.e - a.e) * t, a.n + (b.n - a.n) * t)
    if (!Number.isNaN(v)) {
      sum += v
      seen++
    }
  }
  const mean = seen ? sum / seen : 0
  return [mean, mean]
}

/** What a line whose span crosses no measured ground at all knows about itself: nothing. */
const NOTHING_MEASURED: Metrics = {
  clearanceMin: NaN,
  clearanceMargin: NaN,
  exposure: NaN,
  canopyClearanceMin: NaN,
  canopyBlockedFraction: NaN,
  clearanceDeficit: 0,
  anchorZoneDeficit: 0,
  crossingDeficit: 0,
  worstCrossing: -1,
  worstClearance: NaN,
}

/**
 * Measures an arbitrary user-placed line, whether or not it qualifies.
 *
 * The counterpart to evaluateLine in the pipeline, and deliberately built from the same parts --
 * same height selection, same profile sampling, same metrics, same score -- so a hand-placed line's
 * numbers can be compared directly against a found candidate's rather than approximately.
 *
 * The two differences are both intentional. Heights are chosen with an unbounded offlevel budget,
 * so a mismatched pair reports how far off level it is instead of being refused. And nothing is
 * rejected: failures come back as `violations` for display, because "why does this spot not work"
 * is as useful an answer as a list of spots that do.
 *
 * Pass `rig` to set the attachment heights by hand instead of taking the best available pair.
 */
export function planLine(
  a: Pos,
  b: Pos,
  ground: Sampler,
  surface: Sampler,
  sagRatio: number,
  p: Params,
  rig: RigHeights | null = null,
  /** The city model and the road network. Empty measures bare elevation, as the tests do. */
  scene: Scene = {},
  /**
   * Whether to measure a line the elevation service has only partly covered.
   *
   * Off by default, and the optimiser depends on that: it reads this function's null as "not a
   * line" and skips the position, which is how an anchor is kept out of ground nothing is known
   * about. Turning it on there would let a walk wander into a gap and score it as clear air.
   *
   * The panel turns it on, and for the panel a line is never nothing: a chart of most of a line
   * beats a spinner over all of it, and a dragged anchor is in ground still being fetched most of
   * the time it is moving. It goes as far as standing an anchor on a height nobody has measured --
   * see `standOn` -- so that the span itself always draws.
   *
   * What came back partial is not reported separately: the profile carries a NaN at every station
   * that was not measured, and the first and last of those are the anchors, which is the same fact
   * and the one thing that draws the chart. Every figure on a partial line describes only the
   * ground that was seen, and describes it optimistically -- a clearance minimum cannot see into a
   * stretch it never read, and the hill that would have set it may be exactly there. Anything
   * showing those numbers has to say so.
   */
  { tolerateGaps = false }: { tolerateGaps?: boolean } = {},
): PlannedLine | null {
  const measuredA = ground.sample(a.e, a.n)
  const measuredB = ground.sample(b.e, b.n)
  const blind = Number.isNaN(measuredA) || Number.isNaN(measuredB)
  if (blind && !tolerateGaps) return null

  const length = Math.hypot(b.e - a.e, b.n - a.n)
  if (length < 1) return null

  const [gA, gB] = blind ? standOn(a, b, measuredA, measuredB, ground) : [measuredA, measuredB]

  const onRoofA = scene.roofs?.covers(a.e, a.n) ?? false
  const onRoofB = scene.roofs?.covers(b.e, b.n) ?? false
  const rangeA = rigRange(onRoofA, p)
  const rangeB = rigRange(onRoofB, p)
  const h = rig
    ? { hA: gA + rig.a, hB: gB + rig.b, offLevel: Math.abs(gA + rig.a - (gB + rig.b)) }
    : chooseHeights(
        gA + rangeA.min,
        gA + rangeA.max,
        gB + rangeB.min,
        gB + rangeB.max,
        Infinity,
      )
  if (!h) return null

  const profile = buildProfile(a, b, h.hA, h.hB, length, ground, surface, p, scene)
  if (!tolerateGaps && profile.some((s) => Number.isNaN(s.ground))) return null

  const stored = packProfile(profile, p)
  const crossings = scene.roads?.crossings(a, b, p, { ground, surface }) ?? []
  // Null means not one station along the span was measured, which for a tolerant caller is a line
  // whose figures are unknown rather than a line that does not exist. NaN says unknown where zero
  // would say measured-and-fine, and the charges are zero because nothing seen is nothing to charge.
  const m =
    rawMetricsAt(stored, length, h.hA, h.hB, sagRatio, p, crossings) ??
    (tolerateGaps ? NOTHING_MEASURED : null)
  if (!m) return null

  const r2 = (v: number) => Math.round(v * 100) / 100
  const { score, parts } = scoreOf(length, h.offLevel, m, p)
  // The one failure no anchor move can undo, so it is charged here rather than inside scoreOf: it
  // is a property of the rig setting, not of the terrain the search is walking over.
  const ends: [RigEnd, RigEnd] = [
    { aFrame: h.hA - gA, max: rangeA.max },
    { aFrame: h.hB - gB, max: rangeB.max },
  ]
  const rigCharge = rigPenalty(ends[0], ends[1])
  const wa = toWgs84(a.e, a.n)
  const wb = toWgs84(b.e, b.n)
  return {
    candidate: {
      id: PLANNED_ID,
      kind: lineKind(onRoofA, onRoofB),
      // The *measured* ground, so an assumed one reads as unknown rather than as a survey figure.
      // `anchor` is the height the span is actually drawn at, assumed or not, because the chart has
      // to put the line somewhere and that is where it put it.
      a: { ...wa, e: a.e, n: a.n, ground: r2(measuredA), anchor: r2(h.hA), aFrame: r2(h.hA - measuredA) },
      b: { ...wb, e: b.e, n: b.n, ground: r2(measuredB), anchor: r2(h.hB), aFrame: r2(h.hB - measuredB) },
      length: Math.round(length * 10) / 10,
      bearing: Math.round((Math.atan2(b.e - a.e, b.n - a.n) * 180) / Math.PI + 360) % 360,
      sag: r2(sagRatio * length),
      offLevel: r2(h.offLevel),
      offLevelRatio: Math.round((h.offLevel / length) * 10000) / 10000,
      clearanceMin: r2(m.clearanceMin),
      exposure: r2(m.exposure),
      canopyClearanceMin: r2(m.canopyClearanceMin),
      canopyBlockedFraction: Math.round(m.canopyBlockedFraction * 1000) / 1000,
      // Deliberately not rounded, unlike a found candidate's: the optimiser ranks on this, and at
      // one decimal a gentle slope reads as flat and the walk stops after its first step.
      score: score - rigCharge,
      scoreParts: parts,
      maxSagRatio: maxFeasibleSag(stored, length, h.hA, h.hB, p, crossings),
      crossings,
      profile: stored,
    },
    violations: [...violationsOf(m, length, h.offLevel, p, crossings), ...rigViolations(ends)],
    penalty: penaltyOf(m, length, h.offLevel, p) + rigCharge,
  }
}

/**
 * A rig height the anchor cannot supply, in words.
 *
 * Two different sentences because they are two different problems. On the ground the limit is how
 * far a carried frame reaches, and going over it means bringing a bigger one. On a roof the limit
 * is zero and there is nothing to raise the line with -- the parapet is where it attaches -- so
 * quoting "over the 0 m an A-frame reaches" would state the rule and hide the reason.
 */
function rigViolations(ends: [RigEnd, RigEnd]): string[] {
  return (['A', 'B'] as const)
    .map((label, i) => ({ label, end: ends[i]! }))
    .filter(({ end }) => end.aFrame > end.max + 1e-9)
    .map(({ label, end }) =>
      end.max > 0
        ? `rigged ${end.aFrame.toFixed(1)} m up at ${label}, over the ${end.max} m an A-frame reaches`
        : `rigged ${end.aFrame.toFixed(1)} m above the roof at ${label}, which attaches at roof level`,
    )
}
