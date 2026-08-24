import { describe, expect, it } from 'vitest'
import { optimizeStep, PLANNED_REFINE_RADIUS, PLANNED_REFINE_STEP } from './optimize.js'
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

describe('optimizeStep', () => {
  const g = terrain()
  const start = { a: at(85, 100), b: at(315, 100) }
  const o = { origin: start, ground: g, surface: g, sagRatio: 0.05, params: p, rig: null, reach: 1 }
  const scoreOf = (pl: { a: typeof start.a; b: typeof start.b }) =>
    planLine(pl.a, pl.b, g, g, 0.05, p)!.candidate.score

  it('improves the score it is given', () => {
    const next = optimizeStep(start, o)!
    expect(next).not.toBeNull()
    expect(scoreOf(next)).toBeGreaterThan(scoreOf(start))
  })

  it('moves at most one step per anchor, so the walk is watchable', () => {
    const next = optimizeStep(start, o)!
    for (const which of ['a', 'b'] as const) {
      const d = Math.hypot(next[which].e - start[which].e, next[which].n - start[which].n)
      expect(d).toBeLessThanOrEqual(PLANNED_REFINE_STEP + 1e-9)
    }
  })

  it('never wanders further than the allowed radius from where it started', () => {
    let cur = start
    for (let i = 0; i < 200; i++) {
      const next = optimizeStep(cur, o)
      if (!next) break
      cur = next
    }
    for (const which of ['a', 'b'] as const) {
      const d = Math.hypot(cur[which].e - start[which].e, cur[which].n - start[which].n)
      expect(d).toBeLessThanOrEqual(PLANNED_REFINE_RADIUS + 1e-9)
    }
  })

  it('steps and wanders proportionally further at a bigger reach', () => {
    // Steep enough that the walk keeps improving until the radius stops it, which is the point.
    const steep = terrain(1 / 2)
    const opts = (reach: number) => ({ ...o, ground: steep, surface: steep, reach })
    /** How far the anchor that moved most ended up from where it started. */
    const settle = (reach: number) => {
      let cur = start
      for (let i = 0; i < 500; i++) {
        const next = optimizeStep(cur, opts(reach))
        if (!next) break
        cur = next
      }
      return Math.max(
        Math.hypot(cur.a.e - start.a.e, cur.a.n - start.a.n),
        Math.hypot(cur.b.e - start.b.e, cur.b.n - start.b.n),
      )
    }

    // At least, not exactly: one call tries each direction in turn from wherever the last one
    // left the anchor, so two agreeing directions compound within a single step.
    const step = optimizeStep(start, opts(4))!
    expect(Math.hypot(step.a.e - start.a.e, step.a.n - start.a.n)).toBeGreaterThanOrEqual(
      PLANNED_REFINE_STEP * 4 - 1e-9,
    )
    expect(settle(4)).toBeGreaterThan(PLANNED_REFINE_RADIUS)
    expect(settle(4)).toBeLessThanOrEqual(PLANNED_REFINE_RADIUS * 4 + 1e-9)
  })

  it('stops by returning null once it is at a local maximum', () => {
    let cur = start
    let steps = 0
    while (steps < 300) {
      const next = optimizeStep(cur, o)
      if (!next) break
      cur = next
      steps++
    }
    expect(steps).toBeLessThan(300)
    expect(optimizeStep(cur, o)).toBeNull()
  })

  it('returns null where there is no elevation to measure', () => {
    const empty = Grid.filled(400, 400, 408000, 5784400, 1)
    expect(optimizeStep(start, { ...o, ground: empty, surface: empty })).toBeNull()
  })
})
