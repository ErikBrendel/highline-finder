import type { Pos, Sampler } from './grid.js'
import { buildProfile } from './profile.js'
import {
  chooseHeights,
  lineOverProfile,
  rawMetrics,
  scoreOf,
  violationsOf,
} from './scoring.js'
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
): PlannedLine | null {
  const gA = ground.sample(a.e, a.n)
  const gB = ground.sample(b.e, b.n)
  if (Number.isNaN(gA) || Number.isNaN(gB)) return null

  const length = Math.hypot(b.e - a.e, b.n - a.n)
  if (length < 1) return null

  const h = rig
    ? { hA: gA + rig.a, hB: gB + rig.b, offLevel: Math.abs(gA + rig.a - (gB + rig.b)) }
    : chooseHeights(
        gA + p.aFrameMin,
        gA + p.aFrameMax,
        gB + p.aFrameMin,
        gB + p.aFrameMax,
        Infinity,
      )
  if (!h) return null

  const profile = buildProfile(a, b, h.hA, h.hB, length, ground, surface, p)
  if (profile.some((s) => Number.isNaN(s.ground))) return null

  const line = lineOverProfile(profile, length, h.hA, h.hB, sagRatio)
  const m = rawMetrics(profile, line, length, p)
  if (!m) return null

  const r2 = (v: number) => Math.round(v * 100) / 100
  const { score, parts } = scoreOf(length, h.offLevel, m, p)
  const wa = toWgs84(a.e, a.n)
  const wb = toWgs84(b.e, b.n)
  return {
    candidate: {
      id: PLANNED_ID,
      a: { ...wa, e: a.e, n: a.n, ground: r2(gA), anchor: r2(h.hA), aFrame: r2(h.hA - gA) },
      b: { ...wb, e: b.e, n: b.n, ground: r2(gB), anchor: r2(h.hB), aFrame: r2(h.hB - gB) },
      length: Math.round(length * 10) / 10,
      bearing: Math.round((Math.atan2(b.e - a.e, b.n - a.n) * 180) / Math.PI + 360) % 360,
      sag: r2(sagRatio * length),
      offLevel: r2(h.offLevel),
      offLevelRatio: Math.round((h.offLevel / length) * 10000) / 10000,
      clearanceMin: r2(m.clearanceMin),
      exposure: r2(m.exposure),
      canopyClearanceMin: r2(m.canopyClearanceMin),
      canopyBlockedFraction: Math.round(m.canopyBlockedFraction * 1000) / 1000,
      score: Math.round(score * 10) / 10,
      scoreParts: parts,
      profile: profile.map((s, i) => ({ ...s, line: r2(line[i]!) })),
    },
    violations: [...violationsOf(m, length, h.offLevel, p), ...rigViolations(h, gA, gB, p)],
  }
}

function rigViolations(
  h: { hA: number; hB: number },
  gA: number,
  gB: number,
  p: Params,
): string[] {
  return ([['A', h.hA - gA], ['B', h.hB - gB]] as const)
    .filter(([, aFrame]) => aFrame > p.aFrameMax + 1e-9)
    .map(
      ([label, aFrame]) =>
        `rigged ${aFrame.toFixed(1)} m up at ${label}, over the ${p.aFrameMax} m an A-frame reaches`,
    )
}
