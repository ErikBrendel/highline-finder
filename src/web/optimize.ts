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
 * toward qualifying before it starts polishing. The count on its own is a step function with no
 * downhill direction, which is why the score carries a continuous penalty for how badly each
 * constraint is broken -- that is what gives an anchor inside a building a direction to walk. The
 * pipeline has no equivalent because it never holds an invalid line in the first place.
 */

/**
 * How far each anchor may wander from where it was placed, in metres, at reach 1.
 *
 * Larger than the pipeline's `refineRadius`, which exists to nudge a found line off the 5 m anchor
 * lattice. Here the starting point is wherever a person happened to click, so the useful question is
 * a different one: is there something better within a stone's throw of this spot.
 */
export const PLANNED_REFINE_RADIUS = 25

/**
 * Finest move the walk ever makes, in metres. Every run ends at this resolution, whatever its reach.
 *
 * A tenth of a metre, not a metre: the samplers are bilinear, so sub-metre moves do change what the
 * line measures, and the things worth resolving at that scale are real. A roof edge is a one-metre
 * ramp in the composite ground, and a metre-grid search either stands on the roof or beside it with
 * nothing in between.
 */
export const PLANNED_REFINE_STEP = 0.1

/**
 * Descent steps taken per animation frame.
 *
 * Step size and animation speed are separate questions and this is what keeps them separate. Ten
 * tenth-metre steps advance an anchor about a metre per frame, which is the pace the walk was
 * always drawn at -- so making the search ten times finer costs nothing visually. Measured at 36 us
 * per evaluation on a 500 m span, a frame is well under 10 ms of work even with the halvings below.
 */
export const PLANNED_REFINE_SUBSTEPS = 10

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
   * Multiplier on the radius, and on the *travel* step the walk starts at. 1 is the careful default.
   *
   * Only the travel step scales. Whenever the walk can no longer improve, the step halves and it
   * tries again, down to `PLANNED_REFINE_STEP` -- so a run at any reach finishes at the same tenth
   * of a metre a reach-1 run does, and a wide search is not a blunt one. Scaling the radius alone
   * would leave a reach-32 run creeping 0.1 m at a time across 800 m, which is twenty minutes of
   * animation; the coarse phase is how it gets there in the same time a narrow run takes.
   *
   * What a coarse travel step genuinely costs is what it passes over on the way: a two-metre ledge
   * is easy to stride across at 3.2 m a step and there is nothing to notice it. So a wide search
   * finds a different answer, not a strictly better one.
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
 * One descent step at a given move size. Returns the improved pair, or null when neither anchor can
 * do better -- which is how the caller knows to shrink the step, and eventually to stop.
 */
export function optimizeStep(current: Plan, o: Options, step: number): Plan | null {
  let best = rank(current.a, current.b, o)
  if (!best) return null
  const radius = PLANNED_REFINE_RADIUS * o.reach
  let out = current
  let moved = false

  for (const which of ['a', 'b'] as const) {
    // Fixed for this anchor's whole sweep, so it moves at most one step per call however many
    // directions improve on the last -- otherwise two agreeing neighbours compound and the walk
    // jumps instead of creeping, which at a large reach would cover the whole radius in a frame.
    const from = out[which]
    for (const d of DIRECTIONS) {
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

/**
 * One animation frame's worth of descent, coarse to fine.
 *
 * Each frame restarts at the reach's travel step and halves it whenever the walk stalls, down to
 * `PLANNED_REFINE_STEP`. Restarting coarse every frame rather than ratcheting down is deliberate:
 * having moved at a fine step, the coarse direction is often open again, and finding out costs one
 * stalled sweep. Null means even a tenth of a metre cannot improve the line, which is the only
 * thing that stops a run.
 */
export function optimizeFrame(current: Plan, o: Options): Plan | null {
  let out: Plan | null = null
  let cur = current
  let step = PLANNED_REFINE_STEP * o.reach
  for (let i = 0; i < PLANNED_REFINE_SUBSTEPS; i++) {
    let next = optimizeStep(cur, o, step)
    while (!next && step > PLANNED_REFINE_STEP) {
      step = Math.max(PLANNED_REFINE_STEP, step / 2)
      next = optimizeStep(cur, o, step)
    }
    if (!next) break
    cur = next
    out = cur
  }
  return out
}
