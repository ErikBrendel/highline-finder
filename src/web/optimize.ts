import type { Pos, Sampler } from '../shared/grid.js'
import { planLine, type RigHeights } from '../shared/plan.js'
import type { Scene } from '../shared/scene.js'
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
 * Spacing the lattice starts at, in metres, before any reach multiplier.
 *
 * A metre is the resolution of the underlying rasters, so at the start of a run this is the scale
 * at which the terrain actually has features -- and a 36-point patch at a metre covers a three
 * metre circle, which is enough to see which way the ground falls rather than inching toward it.
 */
export const PLANNED_REFINE_START = 1

/**
 * Spacing the lattice winds down to, in metres. Every run ends at this resolution, at any reach.
 *
 * A tenth of a metre, not a metre: the samplers are bilinear, so sub-metre moves do change what the
 * line measures, and the things worth resolving at that scale are real. A roof edge is a one-metre
 * ramp in the composite ground, and a metre-grid search either stands on the roof or beside it with
 * nothing in between.
 */
export const PLANNED_REFINE_FINEST = 0.1

/** Rings of the hex neighbourhood scanned around an anchor. 3 gives 36 candidate positions. */
export const PLANNED_REFINE_RINGS = 3

/**
 * Where an anchor may move in one step: a hexagonal patch of the triangular lattice centred on it,
 * in units of the current spacing, nearest first.
 *
 * A patch rather than the ring of rays this used to be, for two reasons. A ring offers one
 * distance, so the scan picks a direction and the step length is whatever the spacing happens to
 * be; a patch picks both, which lets the walk stride out where the ground rewards it and shorten up
 * near the top without waiting for the halving to notice. And scanning three rings deep can cross a
 * bad band one spacing wide, where a single-ring scan is walled in by neighbours that are all worse
 * than where it stands even though the ground just past them is better. That second one does
 * nothing at the finest spacing -- a tenth of a metre on a bilinear 1 m raster has no such
 * structure to cross -- and everything during a wide run's coarse phase, where a spacing is metres.
 *
 * Hex rather than square because every point of a triangular lattice is the same distance from all
 * six of its neighbours, so the patch has no diagonal that is secretly 41 % further than the rest.
 *
 * Nearest first so that where two positions score identically the anchor takes the closer one and
 * stays put rather than skating.
 */
export const NEIGHBOURHOOD: Pos[] = (() => {
  const r = PLANNED_REFINE_RINGS
  const out: Pos[] = []
  // Axial hex coordinates: the hexagon of radius r is |q| <= r, |s| <= r, |q + s| <= r.
  for (let q = -r; q <= r; q++) {
    for (let t = Math.max(-r, -q - r); t <= Math.min(r, -q + r); t++) {
      if (q === 0 && t === 0) continue
      out.push({ e: q + t / 2, n: (t * Math.sqrt(3)) / 2 })
    }
  }
  return out.sort((x, y) => Math.hypot(x.e, x.n) - Math.hypot(y.e, y.n))
})()

/**
 * Metres an anchor may travel in one animation frame, before the reach multiplier.
 *
 * A distance budget rather than a step count, because a step is worth three spacings and the
 * spacing changes by a factor of ten over a run: counting steps made the coarse phase blur past in
 * two frames and the fine phase crawl. Budgeting distance keeps the drawn pace the same throughout,
 * which is the whole reason the walk is animated instead of run to completion.
 *
 * Scaled by reach, so a wide run takes about as long as a narrow one -- otherwise a reach-32 run
 * would be four hundred frames of watching an anchor cross a field.
 */
export const PLANNED_REFINE_PACE = 2

/**
 * Steps a frame may take however little ground they cover, so a walk that has converged cannot spin
 * on the budget. Eight steps is 576 line evaluations, around 20 ms on a 500 m span.
 */
const MAX_STEPS_PER_FRAME = 8

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
   * The city model and the road network, so the walk knows which of the positions it tries stand on
   * a building and what the line it draws passes over. Omit in tests over bare synthetic terrain,
   * where there is neither.
   */
  scene?: Scene
  /**
   * Multiplier on the radius, and on the lattice spacing the scan starts at. The patch keeps its
   * 36 points and simply covers more ground. 1 is the careful default.
   *
   * Only the starting spacing scales. Whenever the scan can no longer improve, the spacing halves
   * and it tries again, down to `PLANNED_REFINE_FINEST` -- which is not scaled, so a run at any
   * reach finishes on the same tenth-metre lattice, and a wide search is not a blunt one. Scaling
   * the radius alone would leave a reach-32 run creeping across 800 m a metre at a time, which is
   * minutes of animation; the coarse phase is how it gets there in the time a narrow run takes.
   *
   * What a coarse phase genuinely costs is what falls between its points on the way: at reach 32
   * the lattice starts at 32 m and a whole hillside can sit in a gap. So a wide search finds a
   * different answer, not a strictly better one.
   */
  reach: number
  /**
   * Called with every position actually measured, so the map can show what the search looked at.
   * Positions rejected for being outside the radius are not reported: they were skipped, not
   * checked.
   */
  onProbe?: (e: number, n: number) => void
}

function rank(a: Pos, b: Pos, o: Options): { violations: number; score: number } | null {
  const r = planLine(a, b, o.ground, o.surface, o.sagRatio, o.params, o.rig, o.scene)
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
 * One step: scan the neighbourhood of each anchor in turn at the given lattice spacing and move it
 * to the best position found, if any beats where it stands.
 *
 * Returns null when neither anchor can improve, which is how the caller knows to shrink the spacing
 * and eventually to stop. B is scanned against A's new position rather than its old one -- that is
 * what makes this coordinate descent, and also what it cannot see past: a move that only helps if
 * both ends make it together is invisible here.
 */
export function optimizeStep(current: Plan, o: Options, spacing: number): Plan | null {
  let best = rank(current.a, current.b, o)
  if (!best) return null
  const radius = PLANNED_REFINE_RADIUS * o.reach
  let out = current
  let moved = false

  for (const which of ['a', 'b'] as const) {
    // Fixed for the anchor's whole scan, so it lands on one position out of the patch rather than
    // hopping from each improvement to the next and travelling several patches in a single step.
    const from = out[which]
    let to = from
    for (const d of NEIGHBOURHOOD) {
      const at = { e: from.e + d.e * spacing, n: from.n + d.n * spacing }
      if (!within(at, o.origin[which], radius)) continue
      o.onProbe?.(at.e, at.n)
      const score = rank(which === 'a' ? at : out.a, which === 'a' ? out.b : at, o)
      if (!score || !better(score, best)) continue
      best = score
      to = at
      moved = true
    }
    out = which === 'a' ? { a: to, b: out.b } : { a: out.a, b: to }
  }
  return moved ? out : null
}

/**
 * One animation frame's worth of descent, coarse to fine.
 *
 * Each frame restarts at the reach's starting spacing and halves it whenever the scan stalls, down to
 * `PLANNED_REFINE_FINEST`. Restarting coarse every frame rather than ratcheting down is
 * deliberate: having moved at a fine spacing, the coarse patch is often worth another look, and
 * finding out costs one stalled scan. Null means even the finest patch cannot improve the line,
 * which is the only thing that stops a run.
 */
export function optimizeFrame(current: Plan, o: Options): Plan | null {
  const budget = PLANNED_REFINE_PACE * o.reach
  let out: Plan | null = null
  let cur = current
  let spacing = PLANNED_REFINE_START * o.reach
  let travelled = 0

  for (let i = 0; i < MAX_STEPS_PER_FRAME && travelled < budget; i++) {
    let next = optimizeStep(cur, o, spacing)
    while (!next && spacing > PLANNED_REFINE_FINEST) {
      spacing = Math.max(PLANNED_REFINE_FINEST, spacing / 2)
      next = optimizeStep(cur, o, spacing)
    }
    if (!next) break
    travelled += Math.max(
      Math.hypot(next.a.e - cur.a.e, next.a.n - cur.a.n),
      Math.hypot(next.b.e - cur.b.e, next.b.n - cur.b.n),
    )
    cur = next
    out = cur
  }
  return out
}
