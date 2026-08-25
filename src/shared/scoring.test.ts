import { describe, expect, it } from 'vitest'
import {
  lineHeightAt,
  maxFeasibleSag,
  metricsAt,
  penaltyOf,
  rawMetricsAt,
  rescoreAtSag,
  scoreOf,
  violationsOf,
} from './scoring.js'
import { packProfile, unpackProfile } from './profile.js'
import { DEFAULT_PARAMS } from '../pipeline/params.js'
import type { Candidate, ProfileSample } from './types.js'
import type { Metrics } from './scoring.js'

const p = DEFAULT_PARAMS

/** Level 200 m span over a flat floor 30 m below the anchors. */
function flatSpan(anchor = 50, floor = 20, length = 200, step = 5): ProfileSample[] {
  const out: ProfileSample[] = []
  for (let d = 0; d <= length; d += step) {
    const ground = d === 0 || d === length ? anchor : floor
    out.push({ d, ground, surface: ground, line: 0 })
  }
  return out
}

describe('lineHeightAt', () => {
  it('hits both anchors exactly and sags fully at midspan', () => {
    expect(lineHeightAt(50, 60, 8, 0)).toBe(50)
    expect(lineHeightAt(50, 60, 8, 1)).toBe(60)
    expect(lineHeightAt(50, 60, 8, 0.5)).toBeCloseTo(55 - 8, 6)
  })

  it('is symmetric about midspan for a level line', () => {
    expect(lineHeightAt(50, 50, 8, 0.25)).toBeCloseTo(lineHeightAt(50, 50, 8, 0.75), 6)
  })
})

describe('metricsAt', () => {
  const profile = packProfile(flatSpan())

  it('reports the deepest air gap as exposure and the tightest as clearance', () => {
    const m = metricsAt(profile, 200, 52, 52, 0.05, p)!
    // Midspan: 52 - 4 * (0.05 * 200) * 0.25 = 42, over a floor at 20.
    expect(m.clearanceMin).toBeCloseTo(22, 1)
    expect(m.exposure).toBeGreaterThan(m.clearanceMin)
    expect(m.canopyBlockedFraction).toBe(0)
  })

  it('rejects the line once sag brings it into the ground', () => {
    // A floor 4 m below the anchors cannot take a 200 m span at any sag in range.
    const shallow = packProfile(flatSpan(50, 46))
    expect(metricsAt(shallow, 200, 52, 52, 0.05, p)).toBeNull()
  })

  it('ignores clearance inside anchorZone, where the line is necessarily low', () => {
    const m = metricsAt(profile, 200, 52, 52, 0.05, p)!
    // The endpoint sample sits at the anchor with ~2 m of clearance, well under minClearance.
    expect(52 - profile.ground[0]!).toBeLessThan(p.minClearance)
    expect(m.clearanceMin).toBeGreaterThanOrEqual(p.minClearance)
  })

  it('counts canopy the line passes through without rejecting it', () => {
    const treed = packProfile(
      flatSpan().map((s) => ({ ...s, surface: s.d === 0 || s.d === 200 ? s.ground : 45 })),
    )
    const m = metricsAt(treed, 200, 52, 52, 0.05, p)!
    expect(m.canopyBlockedFraction).toBeGreaterThan(0)
    expect(m.canopyClearanceMin).toBeLessThan(0)
  })
})

describe('scoreOf', () => {
  const base = {
    clearanceMin: 5, exposure: 20, canopyClearanceMin: 2, canopyBlockedFraction: 0,
    clearanceDeficit: 0,
  }

  it('scales exposure logarithmically so big lines stay distinguishable', () => {
    const at = (exposure: number) => scoreOf(200, 0, { ...base, exposure }, p).parts.exposure
    expect(at(10)).toBeLessThan(at(40))
    expect(at(40)).toBeLessThan(at(400))
    // Linear scaling would have saturated long before 400 m of air.
    expect(at(400)).toBeLessThanOrEqual(1)
  })

  it('penalises canopy and offlevel', () => {
    const clean = scoreOf(200, 0, base, p).score
    expect(scoreOf(200, 0, { ...base, canopyBlockedFraction: 0.5 }, p).score).toBeLessThan(clean)
    expect(scoreOf(200, p.maxOffLevelRatio * 200, base, p).score).toBeLessThan(clean)
  })
})

describe('penaltyOf', () => {
  /** A flat span with a block of ground raised to `top` over the samples from `from` to `to`. */
  const withBump = (from: number, to: number, top: number) =>
    packProfile(
      flatSpan().map((sm) => (sm.d >= from && sm.d <= to ? { ...sm, ground: top } : sm)),
    )
  const measure = (sp: ReturnType<typeof withBump>) =>
    rawMetricsAt(sp, 200, 50, 50, 0.05, p)!

  it('costs a line that qualifies nothing at all', () => {
    const m = metricsAt(packProfile(flatSpan()), 200, 50, 50, 0.05, p)!
    expect(violationsOf(m, 200, 0, p)).toEqual([])
    expect(penaltyOf(m, 200, 0, p)).toBe(0)
  })

  it('grows with how far the ground rises through the line', () => {
    const shallow = penaltyOf(measure(withBump(90, 110, 44)), 200, 0, p)
    const deep = penaltyOf(measure(withBump(90, 110, 48)), 200, 0, p)
    expect(shallow).toBeGreaterThan(0)
    expect(deep).toBeGreaterThan(shallow)
  })

  it('counts an obstruction at midspan for more than the same one beside an anchor', () => {
    const middle = penaltyOf(measure(withBump(90, 110, 48)), 200, 0, p)
    const nearEnd = penaltyOf(measure(withBump(15, 35, 48)), 200, 0, p)
    expect(nearEnd).toBeGreaterThan(0)
    expect(middle).toBeGreaterThan(nearEnd)
  })

  it('charges for every failure the planner lists, and for nothing it does not', () => {
    const clean = metricsAt(packProfile(flatSpan()), 200, 50, 50, 0.05, p)!
    const cases: [Metrics, number, number][] = [
      [clean, 200, 0],
      [clean, 200, p.maxOffLevelRatio * 200 + 2],
      [clean, p.minLength - 10, 0],
      [clean, p.maxLength + 10, 0],
      [{ ...clean, exposure: p.minExposure - 4 }, 200, 0],
      [{ ...clean, canopyBlockedFraction: p.maxCanopyBlocked + 0.1 }, 200, 0],
      [measure(withBump(90, 110, 48)), 200, 0],
    ]
    for (const [m, length, offLevel] of cases) {
      const failed = violationsOf(m, length, offLevel, p).length > 0
      expect(penaltyOf(m, length, offLevel, p) > 0).toBe(failed)
    }
  })
})

describe('rescoreAtSag', () => {
  const profile = flatSpan()
  const packed = packProfile(profile)
  const m = metricsAt(packed, 200, 52, 52, 0.05, p)!
  const candidate: Candidate = {
    id: 'x',
    kind: 'natural',
    a: { lat: 0, lon: 0, e: 0, n: 0, ground: 50, anchor: 52, aFrame: 1.5 },
    b: { lat: 0, lon: 0, e: 200, n: 0, ground: 50, anchor: 52, aFrame: 1.5 },
    length: 200,
    bearing: 90,
    sag: 10,
    offLevel: 0,
    offLevelRatio: 0,
    clearanceMin: m.clearanceMin,
    exposure: m.exposure,
    canopyClearanceMin: m.canopyClearanceMin,
    canopyBlockedFraction: m.canopyBlockedFraction,
    score: scoreOf(200, 0, m, p).score,
    scoreParts: scoreOf(200, 0, m, p).parts,
    maxSagRatio: maxFeasibleSag(packed, 200, 52, 52, p),
    profile: packed,
  }

  /** The line height at midspan, as the browser derives it. */
  const midLine = (c: Candidate, sagRatio: number) => {
    const samples = unpackProfile(c.profile!, c.length, c.a.anchor, c.b.anchor, sagRatio)
    return samples[Math.floor(samples.length / 2)]!.line
  }

  it('reproduces the original metrics at the sag it was generated with', () => {
    const same = rescoreAtSag(candidate, 0.05, p)!
    expect(same.clearanceMin).toBeCloseTo(candidate.clearanceMin, 1)
    expect(same.exposure).toBeCloseTo(candidate.exposure, 1)
  })

  it('lowers clearance and sag-adjusted profile as sag increases', () => {
    const looser = rescoreAtSag(candidate, 0.08, p)!
    expect(looser.clearanceMin).toBeLessThan(candidate.clearanceMin)
    expect(looser.sag).toBeGreaterThan(candidate.sag)
    expect(midLine(looser, 0.08)).toBeLessThan(midLine(candidate, 0.05))
  })

  it('reports the loosest sag it still clears at', () => {
    expect(candidate.maxSagRatio).toBeGreaterThan(0.05)
    expect(rescoreAtSag(candidate, candidate.maxSagRatio - 0.001, p)).not.toBeNull()
    expect(rescoreAtSag(candidate, candidate.maxSagRatio + 0.005, p)).toBeNull()
  })

  it('answers the validity question from maxSagRatio alone when no profile is stored', () => {
    const { profile: _stored, ...bare } = candidate
    expect(rescoreAtSag(bare, candidate.maxSagRatio, p)).not.toBeNull()
    expect(rescoreAtSag(bare, candidate.maxSagRatio + 0.01, p)).toBeNull()
  })

  it('drops the candidate once sag makes it infeasible', () => {
    // 30 m of air cannot absorb 4 * 0.5 * 200 * 0.25 = 25 m plus the 22 m it already sags.
    expect(rescoreAtSag(candidate, 0.5, p)).toBeNull()
  })

  it('leaves length, offlevel and anchors untouched, since sag does not affect them', () => {
    const looser = rescoreAtSag(candidate, 0.08, p)!
    expect(looser.length).toBe(candidate.length)
    expect(looser.offLevel).toBe(candidate.offLevel)
    expect(looser.a).toEqual(candidate.a)
  })
})

describe('rawMetricsAt', () => {
  /** The definition it replaced: materialise the profile, then measure the objects. */
  function throughObjects(
    sp: { ground: number[]; surface: number[] },
    length: number,
    hA: number,
    hB: number,
    sagRatio: number,
  ) {
    const samples = unpackProfile(sp, length, hA, hB, sagRatio)
    const inner0 = p.anchorZone
    const inner1 = length - p.anchorZone
    let clearanceMin = Infinity
    let exposure = -Infinity
    let canopyClearanceMin = Infinity
    let blocked = 0
    let n = 0
    let deficit = 0
    let weight = 0
    for (const s of samples) {
      const clear = s.line - s.ground
      if (clear > exposure) exposure = clear
      if (s.d < inner0 || s.d > inner1) continue
      if (clear < clearanceMin) clearanceMin = clear
      const canopy = s.line - s.surface
      if (canopy < canopyClearanceMin) canopyClearanceMin = canopy
      if (canopy < 0) blocked++
      const central = Math.min(s.d, length - s.d) / (length / 2)
      weight += central
      if (clear < p.minClearance) deficit += central * (p.minClearance - clear)
      n++
    }
    return {
      clearanceMin,
      exposure,
      canopyClearanceMin,
      canopyBlockedFraction: blocked / n,
      clearanceDeficit: weight > 0 ? deficit / weight : 0,
    }
  }

  it('measures exactly what materialising the profile would have measured', () => {
    let seed = 7
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
    for (let trial = 0; trial < 40; trial++) {
      const n = 40 + Math.floor(rnd() * 90)
      const ground: number[] = []
      const surface: number[] = []
      for (let i = 0; i < n; i++) {
        const g = Math.round((30 + rnd() * 40) * 100) / 100
        ground.push(g)
        surface.push(Math.round((g + rnd() * 25) * 100) / 100)
      }
      const sp = { ground, surface }
      const length = 60 + Math.round(rnd() * 440)
      const hA = 70 + rnd() * 5
      const hB = 70 + rnd() * 5
      const sag = 0.03 + rnd() * 0.07
      expect(rawMetricsAt(sp, length, hA, hB, sag, p)).toEqual(
        throughObjects(sp, length, hA, hB, sag),
      )
    }
  })
})
