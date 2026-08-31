import { describe, expect, it } from 'vitest'
import { PLANNED_RIG_MAX, planLine } from './plan.js'
import { Grid } from './grid.js'
import type { Pos } from './grid.js'
import type { Scene } from './scene.js'
import type { Sampler } from './grid.js'
import { DEFAULT_PARAMS } from '../pipeline/params.js'

const p = DEFAULT_PARAMS

/**
 * A flat plateau at 50 m with a canyon floor at `floor` between e=50 and e=250. `eastRim` lifts the
 * far side, which is what makes the A-frame do any work: with both rims level the choice of
 * attachment height is free.
 */
function terrain(floor: number, canopy = 0, eastRim = 50): { ground: Grid; surface: Grid } {
  const make = (fn: (e: number) => number) => {
    const g = Grid.filled(300, 300, 0, 300, 1)
    for (let row = 0; row < 300; row++) {
      for (let col = 0; col < 300; col++) g.data[row * 300 + col] = fn(col + 0.5)
    }
    return g
  }
  const base = (e: number) => (e >= 250 ? eastRim : e <= 50 ? 50 : floor)
  return { ground: make(base), surface: make((e) => base(e) + (e > 50 && e < 250 ? canopy : 0)) }
}

/** A scene whose city model puts a building under each of the given points and nowhere else. */
const roofsAt = (...points: Pos[]): Scene => ({
  roofs: { covers: (e, n) => points.some((q) => Math.hypot(q.e - e, q.n - n) < 2) },
})

describe('planLine', () => {
  const a = { e: 45, n: 150 }
  const b = { e: 255, n: 150 }

  it('measures a valid line and reports no violations', () => {
    const { ground, surface } = terrain(15)
    const r = planLine(a, b, ground, surface, p.sagRatio, p)!
    expect(r.violations).toEqual([])
    expect(r.candidate.id).toBe('custom')
    expect(r.candidate.length).toBeCloseTo(210, 0)
    expect(r.candidate.clearanceMin).toBeGreaterThanOrEqual(p.minClearance)
  })

  it('still returns a line that fails, with the reasons', () => {
    // A shallow dip: the sagging line runs into the ground and never gets high above it.
    const { ground, surface } = terrain(48)
    const r = planLine(a, b, ground, surface, p.sagRatio, p)!
    expect(r.candidate.length).toBeCloseTo(210, 0)
    expect(r.violations.length).toBeGreaterThan(0)
    expect(r.violations.join(' ')).toMatch(/clears the ground|off the ground/)
  })

  it('reports offlevel instead of refusing a mismatched pair', () => {
    // Rims 8 m apart in height, far beyond what a 1.5 m A-frame range can level out.
    const g = Grid.filled(300, 300, 0, 300, 1)
    for (let row = 0; row < 300; row++) {
      for (let col = 0; col < 300; col++) {
        const e = col + 0.5
        g.data[row * 300 + col] = e <= 50 ? 50 : e >= 250 ? 58 : 15
      }
    }
    const r = planLine(a, b, g, g, p.sagRatio, p)!
    expect(r.candidate.offLevel).toBeCloseTo(8 - p.aFrameMax, 1)
    expect(r.violations.join(' ')).toMatch(/offlevel/)
  })

  it('flags a span outside the length window without discarding it', () => {
    const { ground, surface } = terrain(15)
    const r = planLine({ e: 45, n: 150 }, { e: 75, n: 150 }, ground, surface, p.sagRatio, p)!
    expect(r.candidate.length).toBeCloseTo(30, 0)
    expect(r.violations.join(' ')).toMatch(/under the 50 m minimum/)
  })

  it('scores canopy the line passes through', () => {
    const { ground, surface } = terrain(15, 30)
    const r = planLine(a, b, ground, surface, p.sagRatio, p)!
    expect(r.candidate.canopyBlockedFraction).toBeGreaterThan(0)
    expect(r.candidate.canopyClearanceMin).toBeLessThan(0)
  })

  it('returns null where there is no elevation data', () => {
    const empty = Grid.filled(300, 300, 0, 300, 1)
    expect(planLine(a, b, empty, empty, p.sagRatio, p)).toBeNull()
  })

  it('rigs at the heights it is handed, and derives the offlevel from them', () => {
    const { ground, surface } = terrain(15)
    const r = planLine(a, b, ground, surface, p.sagRatio, p, { a: 0.5, b: 1.2 })!
    expect(r.candidate.a.aFrame).toBeCloseTo(0.5, 2)
    expect(r.candidate.b.aFrame).toBeCloseTo(1.2, 2)
    expect(r.candidate.offLevel).toBeCloseTo(0.7, 2)
  })

  it('flags a rig height no A-frame reaches', () => {
    const { ground, surface } = terrain(15)
    const r = planLine(a, b, ground, surface, p.sagRatio, p, { a: PLANNED_RIG_MAX, b: PLANNED_RIG_MAX })!
    expect(r.violations.join(' ')).toMatch(/over the 1.5 m an A-frame reaches/)
    expect(r.candidate.clearanceMin).toBeGreaterThan(0)
  })

  it('takes the A-frame away from an anchor that stands on a roof', () => {
    // 1.2 m of difference between the rims, which is inside what an A-frame can absorb.
    const { ground, surface } = terrain(15, 0, 51.2)
    const level = planLine(a, b, ground, surface, p.sagRatio, p)!
    expect(level.candidate.offLevel).toBeCloseTo(0, 2)
    expect(level.candidate.kind).toBe('natural')

    const roofed = planLine(a, b, ground, surface, p.sagRatio, p, null, roofsAt(a))!
    expect(roofed.candidate.a.aFrame).toBe(0)
    // Nothing left to raise A with, so the difference the frame used to hide is now offlevel.
    expect(roofed.candidate.offLevel).toBeCloseTo(1.2, 1)
    expect(roofed.candidate.kind).toBe('urban')
    expect(roofed.violations).toEqual([])
  })

  it('calls a line between two roofs urban', () => {
    const { ground, surface } = terrain(15)
    const r = planLine(a, b, ground, surface, p.sagRatio, p, null, roofsAt(a, b))!
    expect(r.candidate.kind).toBe('urban')
    expect(r.candidate.a.aFrame).toBe(0)
    expect(r.candidate.b.aFrame).toBe(0)
  })

  it('says a rig height above a roof is unreachable in terms of the roof', () => {
    const { ground, surface } = terrain(15)
    const r = planLine(a, b, ground, surface, p.sagRatio, p, { a: 1, b: 0 }, roofsAt(a))!
    expect(r.violations.join(' ')).toMatch(/1.0 m above the roof at A/)
    expect(r.penalty).toBeGreaterThan(0)
  })

  it('responds to the sag setting the same way the found candidates do', () => {
    const { ground, surface } = terrain(15)
    const tight = planLine(a, b, ground, surface, 0.05, p)!
    const loose = planLine(a, b, ground, surface, 0.09, p)!
    expect(loose.candidate.clearanceMin).toBeLessThan(tight.candidate.clearanceMin)
    expect(loose.candidate.sag).toBeGreaterThan(tight.candidate.sag)
  })
})


describe('planLine over ground the service has not covered', () => {
  /** Flat terrain with a hole punched through the middle of the span. */
  const from = (h: (e: number) => number): Sampler => ({ sample: h, nearest: h })
  const flat = (e: number) => (e > 120 && e < 180 ? NaN : 50)
  const holed = (): Sampler => from(flat)

  const ends = [{ e: 100, n: 100 }, { e: 200, n: 100 }] as const

  it('refuses by default, which is what keeps the optimiser out of a gap', () => {
    const g = holed()
    expect(planLine(ends[0], ends[1], g, g, 0.05, p)).toBeNull()
  })

  it('measures the rest when asked, and leaves the gap visible in the profile', () => {
    const g = holed()
    const out = planLine(ends[0], ends[1], g, g, 0.05, p, null, {}, { tolerateGaps: true })
    expect(out).not.toBeNull()
    const holes = out!.candidate.profile!.ground.filter((v) => Number.isNaN(v)).length
    expect(holes).toBeGreaterThan(0)
    expect(holes).toBeLessThan(out!.candidate.profile!.ground.length)
  })

  it('reports figures from the measured ground rather than counting a gap as clear air', () => {
    const g = holed()
    // The same span with a wall standing in the part that is measured. If the gap were treated as
    // ground at zero, or skipped without dropping its weight, the wall would stop setting these.
    const walled = from((e: number) =>
      e > 120 && e < 180 ? NaN : e > 105 && e < 115 ? 95 : 50)
    const open = planLine(ends[0], ends[1], g, g, 0.05, p, null, {}, { tolerateGaps: true })!
    const blocked = planLine(ends[0], ends[1], walled, walled, 0.05, p, null, {}, { tolerateGaps: true })!
    expect(blocked.candidate.clearanceMin).toBeLessThan(open.candidate.clearanceMin)
    expect(blocked.candidate.score).toBeLessThan(open.candidate.score)
  })
})
