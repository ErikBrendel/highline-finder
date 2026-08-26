import { describe, expect, it } from 'vitest'
import { steppedOutline } from './ProfileChart.js'
import { COVER_BUILDING, COVER_NONE } from './landcover.js'
import type { ProfileSample } from '../shared/types.js'

const sample = (d: number, ground: number): ProfileSample =>
  ({ d, ground, surface: ground, line: ground + 20, needed: 3 }) as ProfileSample

const coverOf = (kinds: number[], bare: number[]) => ({
  kind: Uint8Array.from(kinds),
  bare: Float32Array.from(bare),
})

/** The terrain outline, which is the series with the bare earth under the wall to fall back on. */
const ground = (p: ProfileSample[], cover: { kind: Uint8Array; bare: Float32Array } | null) =>
  steppedOutline(p, cover, (s) => s.ground, cover ? (i) => cover.bare[i]! : undefined)

describe('steppedOutline', () => {
  /** Pavement at 10 m, then a 20 m building for two samples, then pavement again. */
  const p = [0, 1, 2, 3, 4].map((i) => sample(i * 10, i === 2 || i === 3 ? 30 : 10))
  const cover = coverOf(
    [COVER_NONE, COVER_NONE, COVER_BUILDING, COVER_BUILDING, COVER_NONE],
    [10, 10, 10, 10, 10],
  )

  it('steps up and down a wall instead of ramping into it', () => {
    const out = ground(p, cover)
    // Two extra vertices, both at the wall's own station and at the bare earth beneath it.
    expect(out).toEqual([
      { d: 0, h: 10 },
      { d: 10, h: 10 },
      { d: 20, h: 10 },
      { d: 20, h: 30 },
      { d: 30, h: 30 },
      { d: 30, h: 10 },
      { d: 40, h: 10 },
    ])
  })

  it('never slopes where a building meets the ground', () => {
    // The property, rather than the fixture: no segment may both rise and advance across a wall.
    const out = ground(p, cover)
    for (let i = 1; i < out.length; i++) {
      const rises = Math.abs(out[i]!.h - out[i - 1]!.h) > 0.01
      const advances = out[i]!.d > out[i - 1]!.d
      expect(rises && advances).toBe(false)
    }
  })

  it('falls back to the neighbour when the bare earth under the wall is not known', () => {
    const unknown = coverOf(
      [COVER_NONE, COVER_NONE, COVER_BUILDING, COVER_BUILDING, COVER_NONE],
      [10, 10, NaN, NaN, 10],
    )
    expect(ground(p, unknown)[2]).toEqual({ d: 20, h: 10 })
  })

  it('is the plain series when nothing says where the buildings are', () => {
    expect(ground(p, null).map((v: { h: number }) => v.h)).toEqual([10, 10, 30, 30, 10])
    // A cover array that does not match the profile is not trusted to index into it.
    const wrong = coverOf([COVER_BUILDING], [10])
    expect(ground(p, wrong)).toHaveLength(p.length)
  })
})

describe('the shapes drawn between two stepped series', () => {
  /**
   * A ramp in one series and a wall in the other leaves a wedge between them: that is the green
   * triangle the canopy band showed after the terrain alone was fixed. Both have to step, at the
   * same station, or the fix simply moves the artefact into the next colour up.
   */
  it('steps the canopy at exactly the stations the terrain steps at', () => {
    const p = [0, 1, 2, 3].map((i) => ({
      d: i * 10,
      ground: i === 2 ? 30 : 10,
      surface: i === 2 ? 30 : 14,
      groundMax: i === 2 ? 30 : 10,
      surfaceMax: i === 2 ? 30 : 16,
    })) as ProfileSample[]
    const cover = coverOf(
      [COVER_NONE, COVER_NONE, COVER_BUILDING, COVER_NONE],
      [10, 10, 10, 10],
    )
    const stationsOf = (key: 'ground' | 'surface' | 'groundMax' | 'surfaceMax') =>
      steppedOutline(p, cover, (s) => s[key]).map((v: { d: number }) => v.d)
    const terrain = stationsOf('ground')
    for (const key of ['surface', 'groundMax', 'surfaceMax'] as const) {
      expect(stationsOf(key)).toEqual(terrain)
    }
    // The wall's own station appears three times: the foot, the roof, and the foot again.
    expect(terrain).toEqual([0, 10, 20, 20, 20, 30])
  })
})
