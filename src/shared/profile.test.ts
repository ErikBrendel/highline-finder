import { describe, expect, it } from 'vitest'
import { buildProfile, packProfile, sideHalfWidthAt } from './profile.js'
import { gridFrom } from '../pipeline/testing.js'
import { DEFAULT_PARAMS } from '../pipeline/params.js'
import type { Params } from './types.js'

/**
 * A fixed band width, not the shipped default: these test the mechanism, and pinning the number
 * keeps them from turning red the next time the default is tuned.
 */
const p: Params = { ...DEFAULT_PARAMS, sideClearanceRatio: 0.04 }

/** Flat ground at 20 m, with a wall of `height` running along `n = at` for `e` in [from, to]. */
const withWall = (at: number, height: number, from = 0, to = 400) =>
  gridFrom(400, 400, (e, n) => (Math.abs(n - at) < 1 && e >= from && e <= to ? height : 20))

const span = (g: ReturnType<typeof gridFrom>, params: Params = p) =>
  buildProfile({ e: 20, n: 200 }, { e: 220, n: 200 }, 50, 50, 200, g, g, params)

describe('sideHalfWidthAt', () => {
  it('is pinned at zero on both anchors and widest at midspan', () => {
    expect(sideHalfWidthAt(0, 200, p)).toBe(0)
    expect(sideHalfWidthAt(1, 200, p)).toBe(0)
    expect(sideHalfWidthAt(0.5, 200, p)).toBeCloseTo(p.sideClearanceRatio * 200, 6)
  })

  it('is symmetric about midspan', () => {
    expect(sideHalfWidthAt(0.2, 200, p)).toBeCloseTo(sideHalfWidthAt(0.8, 200, p), 9)
  })
})

describe('buildProfile band', () => {
  it('sees a wall beside the line that the centreline runs clear of', () => {
    // 6 m to the side, against a band reaching 8 m at midspan.
    const profile = span(withWall(206, 60))
    const mid = profile[Math.floor(profile.length / 2)]!
    expect(mid.ground).toBe(20)
    expect(mid.groundMax).toBeCloseTo(60, 0)
  })

  it('ignores the same wall beside an anchor, where the band has no width', () => {
    // The band tapers to nothing at the ends, which is the no-fall zone falling out of the shape.
    const profile = span(withWall(206, 60))
    expect(profile[1]!.groundMax).toBe(profile[1]!.ground)
    expect(profile[profile.length - 2]!.groundMax).toBe(profile[profile.length - 2]!.ground)
  })

  it('leaves a wall outside the band alone', () => {
    const profile = span(withWall(215, 60))
    expect(profile.every((s) => s.groundMax === s.ground)).toBe(true)
  })

  it('measures the bare centreline when the band is switched off', () => {
    const off: Params = { ...p, sideClearanceRatio: 0 }
    const profile = span(withWall(206, 60), off)
    expect(profile.every((s) => s.groundMax === s.ground && s.halfWidth === 0)).toBe(true)
  })

  it('keeps its reach when the sample cap binds, spending a coarser step instead', () => {
    // 500 m of span puts the midspan half-width at 20 m, which is more offsets than the cap allows.
    // The wall at the far edge of the band still has to be found, just sampled less finely.
    const g = gridFrom(700, 700, (e, n) => (n >= 217 && n <= 221 ? 60 : 20))
    const wide = buildProfile({ e: 20, n: 200 }, { e: 520, n: 200 }, 50, 50, 500, g, g, p)
    const mid = wide[Math.floor(wide.length / 2)]!
    expect(mid.halfWidth).toBeCloseTo(20, 0)
    expect(mid.groundMax).toBeCloseTo(60, 0)
  })
})

describe('packProfile', () => {
  it('stores the band only where it says something the centreline does not', () => {
    expect(packProfile(span(withWall(206, 60))).groundMax).toBeDefined()
    const flat = packProfile(span(gridFrom(400, 400, () => 20)))
    expect(flat.groundMax).toBeUndefined()
    expect(flat.surfaceMax).toBeUndefined()
  })
})
