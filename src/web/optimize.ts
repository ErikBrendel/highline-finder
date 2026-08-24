import type { Pos, Sampler } from '../shared/grid.js'
import { planLine, type RigHeights } from '../shared/plan.js'
import type { Params } from '../shared/types.js'

/**
 * Interactive counterpart to the pipeline's refinement pass.
 *
 * Same idea -- coordinate descent, one anchor at a time, over a small neighbourhood -- but taken one
 * step per call so the caller can animate it. Watching the anchors creep toward a better line is
 * worth more here than arriving instantly: it shows *which* direction the terrain rewards, which is
 * the thing a person planning a line actually wants to know.
 *
 * Moves are ranked by violations first and score second, so a line that does not yet qualify walks
 * toward qualifying before it starts polishing. The pipeline has no equivalent because it never
 * holds an invalid line in the first place.
 */

/**
 * How far each anchor may wander from where it was placed, in metres, at reach 1.
 *
 * Larger than the pipeline's `refineRadius`, which exists to nudge a found line off the 5 m anchor
 * lattice. Here the starting point is wherever a person happened to click, so the useful question is
 * a different one: is there something better within a stone's throw of this spot.
 */
export const PLANNED_REFINE_RADIUS = 25

/** Metres moved per step, at reach 1. Small enough that the animation reads as motion, not jumps. */
export const PLANNED_REFINE_STEP = 1

const DIRECTIONS: Pos[] = [
  { e: 1, n: 0 }, { e: -1, n: 0 }, { e: 0, n: 1 }, { e: 0, n: -1 },
  { e: 0.7071, n: 0.7071 }, { e: 0.7071, n: -0.7071 },
  { e: -0.7071, n: 0.7071 }, { e: -0.7071, n: -0.7071 },
]

export interface Plan {
  a: Pos
  b: Pos
}

interface Options {
  origin: Plan
  ground: Sampler
  surface: Sampler
  sagRatio: number
  params: Params
  rig: RigHeights | null
  /**
   * Multiplier on both the radius and the step, so a run covers more ground in about the same
   * number of frames. Scaling only the radius would make a wide search take proportionally longer
   * to walk; scaling only the step would jump about inside the same small circle. 1 is the careful
   * default.
   *
   * Coarser steps can stride over a narrow optimum, which is the honest cost of asking for reach:
   * a wide search finds a different kind of answer, not a strictly better one.
   */
  reach: number
}

function rank(a: Pos, b: Pos, o: Options): { violations: number; score: number } | null {
  const r = planLine(a, b, o.ground, o.surface, o.sagRatio, o.params, o.rig)
  if (!r) return null
  return { violations: r.violations.length, score: r.candidate.score }
}

const better = (
  x: { violations: number; score: number },
  y: { violations: number; score: number },
) => x.violations < y.violations || (x.violations === y.violations && x.score > y.score)

const within = (p: Pos, origin: Pos, radius: number) =>
  Math.hypot(p.e - origin.e, p.n - origin.n) <= radius + 1e-9

/**
 * One descent step. Returns the improved pair, or null when neither anchor can do better -- which
 * is how the caller knows to stop.
 */
export function optimizeStep(current: Plan, o: Options): Plan | null {
  let best = rank(current.a, current.b, o)
  if (!best) return null
  const radius = PLANNED_REFINE_RADIUS * o.reach
  const step = PLANNED_REFINE_STEP * o.reach
  let out = current
  let moved = false

  for (const which of ['a', 'b'] as const) {
    for (const d of DIRECTIONS) {
      const from = out[which]
      const to = { e: from.e + d.e * step, n: from.n + d.n * step }
      if (!within(to, o.origin[which], radius)) continue
      const next = which === 'a' ? { a: to, b: out.b } : { a: out.a, b: to }
      const score = rank(next.a, next.b, o)
      if (!score || !better(score, best)) continue
      best = score
      out = next
      moved = true
    }
  }
  return moved ? out : null
}
