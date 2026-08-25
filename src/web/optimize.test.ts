import { describe, expect, it } from 'vitest'
import {
  NEIGHBOURHOOD,
  optimizeFrame,
  optimizeStep,
  startingSpacing,
  PLANNED_REFINE_RADIUS,
  PLANNED_REFINE_RINGS,
  PLANNED_REFINE_FINEST,
} from './optimize.js'
import { Grid } from '../shared/grid.js'
import { planLine } from '../shared/plan.js'
import { DEFAULT_PARAMS } from '../pipeline/params.js'

const p = DEFAULT_PARAMS

/**
 * A canyon running north-south whose floor deepens toward the north, so moving both anchors north
 * strictly improves exposure and therefore score. `perMetre` sets how fast: the default is gentle
 * enough that the walk settles after a step or two, which is what most of these tests want.
 */
function terrain(perMetre = 1 / 20): Grid {
  const g = Grid.filled(400, 400, 408000, 5784400, 1)
  for (let row = 0; row < 400; row++) {
    for (let col = 0; col < 400; col++) {
      const e = col + 0.5
      const n = 400 - row
      g.data[row * 400 + col] = e <= 90 || e >= 310 ? 60 : 60 - (18 + n * perMetre)
    }
  }
  return g
}

const at = (e: number, n: number) => ({ e: 408000 + e, n: 5784000 + n })

describe('NEIGHBOURHOOD', () => {
  it('is a hexagon of the right size, on a lattice of unit spacing', () => {
    const r = PLANNED_REFINE_RINGS
    // 3r^2 + 3r + 1 points in a hexagon of radius r, less the centre the anchor already stands on.
    expect(NEIGHBOURHOOD).toHaveLength(3 * r * r + 3 * r)
    const d = NEIGHBOURHOOD.map((o) => Math.hypot(o.e, o.n))
    expect(Math.min(...d)).toBeCloseTo(1)
    expect(Math.max(...d)).toBeCloseTo(r)
    // Nearest first, so a tie leaves the anchor as close to where it was as possible.
    expect([...d].sort((x, y) => x - y)).toEqual(d)
  })

  it('covers every direction, unlike the ring of rays it replaced', () => {
    const bearings = NEIGHBOURHOOD.map((o) => Math.atan2(o.e, o.n))
    // Six corners and six edge midpoints at the least, so no 45 degree blind spots.
    expect(new Set(bearings.map((b) => b.toFixed(3))).size).toBeGreaterThan(12)
  })
})

describe('optimizeStep', () => {
  const g = terrain()
  const start = { a: at(85, 100), b: at(315, 100) }
  const o = { origin: start, ground: g, surface: g, sagRatio: 0.05, params: p, rig: null, reach: 1 }
  const fine = PLANNED_REFINE_FINEST
  const scoreOf = (pl: { a: typeof start.a; b: typeof start.b }) =>
    planLine(pl.a, pl.b, g, g, 0.05, p)!.candidate.score

  it('improves the score it is given', () => {
    const next = optimizeStep(start, o, fine)!
    expect(next).not.toBeNull()
    expect(scoreOf(next)).toBeGreaterThan(scoreOf(start))
  })

  it('moves at most one patch per anchor, so the walk is watchable', () => {
    const next = optimizeStep(start, o, fine)!
    for (const which of ['a', 'b'] as const) {
      const d = Math.hypot(next[which].e - start[which].e, next[which].n - start[which].n)
      expect(d).toBeLessThanOrEqual(fine * PLANNED_REFINE_RINGS + 1e-9)
    }
  })

  it('never wanders further than the allowed radius from where it started', () => {
    let cur = start
    for (let i = 0; i < 400; i++) {
      const next = optimizeStep(cur, o, fine * 4)
      if (!next) break
      cur = next
    }
    for (const which of ['a', 'b'] as const) {
      const d = Math.hypot(cur[which].e - start[which].e, cur[which].n - start[which].n)
      expect(d).toBeLessThanOrEqual(PLANNED_REFINE_RADIUS + 1e-9)
    }
  })

  it('stops by returning null once it is at a local maximum', () => {
    let cur = start
    let steps = 0
    while (steps < 600) {
      const next = optimizeStep(cur, o, fine)
      if (!next) break
      cur = next
      steps++
    }
    expect(steps).toBeLessThan(600)
    expect(optimizeStep(cur, o, fine)).toBeNull()
  })

  it('returns null where there is no elevation to measure', () => {
    const empty = Grid.filled(400, 400, 408000, 5784400, 1)
    expect(optimizeStep(start, { ...o, ground: empty, surface: empty }, fine)).toBeNull()
  })
})

describe('optimizeFrame', () => {
  it('reports the spacing it reached, so the next frame carries on rather than starting over', () => {
    const g = terrain(1 / 2)
    const at = { a: { e: 408085, n: 5784100 }, b: { e: 408315, n: 5784100 } }
    const o = { origin: at, ground: g, surface: g, sagRatio: 0.05, params: p, rig: null, reach: 1 }
    const first = optimizeFrame(at, o, startingSpacing(1))!
    expect(first.spacing).toBeLessThanOrEqual(startingSpacing(1))
    expect(first.spacing).toBeGreaterThanOrEqual(PLANNED_REFINE_FINEST)
    // Handed its own spacing back, it picks up from there rather than re-walking the ladder.
    const second = optimizeFrame(first.plan, o, first.spacing)
    if (second) expect(second.spacing).toBeLessThanOrEqual(first.spacing)
  })

  // Steep enough that the walk keeps improving until the radius stops it, which is the point.
  const g = terrain(1 / 2)
  const start = { a: at(85, 100), b: at(315, 100) }
  const opts = (reach: number) => ({
    origin: start, ground: g, surface: g, sagRatio: 0.05, params: p, rig: null, reach,
  })
  /**
   * Runs to convergence, carrying the spacing between frames exactly as the app does. Restarting it
   * each frame is what the walk stopped doing, and a test that restarted it would be measuring
   * something the app no longer runs.
   */
  const settle = (reach: number) => {
    let cur = start
    let spacing = startingSpacing(reach)
    for (let i = 0; i < 4000; i++) {
      const advance = optimizeFrame(cur, opts(reach), spacing)
      if (!advance) break
      cur = advance.plan
      spacing = advance.spacing
    }
    return cur
  }
  const wander = (pl: typeof start) =>
    Math.max(
      Math.hypot(pl.a.e - start.a.e, pl.a.n - start.a.n),
      Math.hypot(pl.b.e - start.b.e, pl.b.n - start.b.n),
    )

  it('stays inside the careful radius at reach 1 and travels past it at a bigger reach', () => {
    expect(wander(settle(1))).toBeLessThanOrEqual(PLANNED_REFINE_RADIUS + 1e-9)
    expect(wander(settle(4))).toBeGreaterThan(PLANNED_REFINE_RADIUS)
    expect(wander(settle(4))).toBeLessThanOrEqual(PLANNED_REFINE_RADIUS * 4 + 1e-9)
  })

  it('finishes at the finest step however coarsely it travelled', () => {
    // The point of halving: a reach-8 run covers eight times the ground but does not leave the
    // anchors on an eight-times-coarser lattice. Nothing is left for a centimetre step to find.
    for (const reach of [1, 8]) {
      const settled = settle(reach)
      expect(optimizeStep(settled, opts(reach), PLANNED_REFINE_FINEST)).toBeNull()
    }
  })
})

describe('walking out of an obstruction', () => {
  /**
   * The canyon with a wall built across its floor, tall at the south end of the search area and
   * tapering away northward, so a line placed at the south end is buried in it and one twenty
   * metres north clears it comfortably.
   *
   * What this exercises is the score's penalty for hard-constraint failures. Without one, an
   * invalid line's score says only how good it would be if the rules did not apply, and there is
   * nothing to distinguish a line grazing the wall from one buried in it -- so the walk has no
   * reason to prefer the shallower end.
   */
  const ground = terrain()
  const surface = terrain()
  for (let row = 0; row < 400; row++) {
    for (let col = 0; col < 400; col++) {
      const e = col + 0.5
      const n = 400 - row
      if (e <= 90 || e >= 310 || n < 40) continue
      const wall = Math.max(ground.data[row * 400 + col]!, 56 - (n - 40) * 0.5)
      ground.data[row * 400 + col] = wall
      surface.data[row * 400 + col] = wall
    }
  }

  const start = { a: at(85, 45), b: at(315, 45) }
  const o = { origin: start, ground, surface, sagRatio: 0.05, params: p, rig: null, reach: 1 }
  const measure = (pl: typeof start) => planLine(pl.a, pl.b, ground, surface, 0.05, p)!

  it('walks a line buried in the wall out to one that qualifies', () => {
    const before = measure(start)
    expect(before.violations.length).toBeGreaterThan(0)
    expect(before.penalty).toBeGreaterThan(0)
    expect(before.candidate.score).toBeLessThan(0)

    let cur = start
    let spacing = startingSpacing(o.reach)
    for (let i = 0; i < 4000; i++) {
      const advance = optimizeFrame(cur, o, spacing)
      if (!advance) break
      cur = advance.plan
      spacing = advance.spacing
    }

    const after = measure(cur)
    expect(after.violations).toEqual([])
    expect(after.penalty).toBe(0)
    expect(after.candidate.score).toBeGreaterThan(before.candidate.score)
    // North, out from under the tall end of the wall.
    expect(cur.a.n).toBeGreaterThan(start.a.n)
  })
})
