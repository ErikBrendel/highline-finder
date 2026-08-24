import { describe, expect, it } from 'vitest'
import {
  lineHeightAt,
  lineOverProfile,
  maxFeasibleSag,
  metricsOf,
  rescoreAtSag,
  scoreOf,
} from './scoring.js'
import { packProfile, unpackProfile } from './profile.js'
import { DEFAULT_PARAMS } from '../pipeline/params.js'
import type { Candidate, ProfileSample } from './types.js'

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

describe('metricsOf', () => {
  const profile = flatSpan()

  it('reports the deepest air gap as exposure and the tightest as clearance', () => {
    const line = lineOverProfile(profile, 200, 52, 52, 0.05)
    const m = metricsOf(profile, line, 200, p)!
    // Midspan: 52 - 4 * (0.05 * 200) * 0.25 = 42, over a floor at 20.
    expect(m.clearanceMin).toBeCloseTo(22, 1)
    expect(m.exposure).toBeGreaterThan(m.clearanceMin)
    expect(m.canopyBlockedFraction).toBe(0)
  })

  it('rejects the line once sag brings it into the ground', () => {
    // A floor 4 m below the anchors cannot take a 200 m span at any sag in range.
    const shallow = flatSpan(50, 46)
    const line = lineOverProfile(shallow, 200, 52, 52, 0.05)
    expect(metricsOf(shallow, line, 200, p)).toBeNull()
  })

  it('ignores clearance inside anchorZone, where the line is necessarily low', () => {
    const line = lineOverProfile(profile, 200, 52, 52, 0.05)
    const m = metricsOf(profile, line, 200, p)!
    // The endpoint samples sit at the anchor with ~2 m of clearance, well under minClearance.
    expect(line[0]! - profile[0]!.ground).toBeLessThan(p.minClearance)
    expect(m.clearanceMin).toBeGreaterThanOrEqual(p.minClearance)
  })

  it('counts canopy the line passes through without rejecting it', () => {
    const treed = flatSpan().map((s) => ({ ...s, surface: s.d === 0 || s.d === 200 ? s.ground : 45 }))
    const line = lineOverProfile(treed, 200, 52, 52, 0.05)
    const m = metricsOf(treed, line, 200, p)!
    expect(m.canopyBlockedFraction).toBeGreaterThan(0)
    expect(m.canopyClearanceMin).toBeLessThan(0)
  })
})

describe('scoreOf', () => {
  const base = { clearanceMin: 5, exposure: 20, canopyClearanceMin: 2, canopyBlockedFraction: 0 }

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

describe('rescoreAtSag', () => {
  const profile = flatSpan()
  const line = lineOverProfile(profile, 200, 52, 52, 0.05)
  const m = metricsOf(profile, line, 200, p)!
  const candidate: Candidate = {
    id: 'x',
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
    maxSagRatio: maxFeasibleSag(packProfile(profile), 200, 52, 52, p),
    profile: packProfile(profile),
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
