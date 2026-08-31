import { describe, expect, it } from 'vitest'
import {
  lineHeightAt,
  maxFeasibleSag,
  metricsAt,
  penaltyOf,
  rawMetricsAt,
  rescoreForDisplay,
  rejectionOf,
  rescoreAtSag,
  scoreOf,
  violationsOf,
} from './scoring.js'
import { packProfile, unpackProfile } from './profile.js'
import { DEFAULT_PARAMS } from '../pipeline/params.js'
import type { Candidate, Crossing, ProfileSample } from './types.js'
import type { Metrics } from './scoring.js'

const p = DEFAULT_PARAMS

/** Level 200 m span over a flat floor 30 m below the anchors. */
function flatSpan(anchor = 50, floor = 20, length = 200, step = 5): ProfileSample[] {
  const out: ProfileSample[] = []
  for (let d = 0; d <= length; d += step) {
    const ground = d === 0 || d === length ? anchor : floor
    out.push({
      d, ground, surface: ground, groundMax: ground, surfaceMax: ground, line: 0, halfWidth: 0,
      needed: p.minClearance,
    })
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
  const profile = packProfile(flatSpan(), p)

  it('reports the deepest air gap as exposure and the tightest as clearance', () => {
    const m = metricsAt(profile, 200, 52, 52, 0.05, p)!
    // Midspan: 52 - 4 * (0.05 * 200) * 0.25 = 42, over a floor at 20.
    expect(m.clearanceMin).toBeCloseTo(22, 1)
    expect(m.exposure).toBeGreaterThan(m.clearanceMin)
    expect(m.canopyBlockedFraction).toBe(0)
  })

  it('rejects the line once sag brings it into the ground', () => {
    // A floor 4 m below the anchors cannot take a 200 m span at any sag in range.
    const shallow = packProfile(flatSpan(50, 46), p)
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
      p,
    )
    const m = metricsAt(treed, 200, 52, 52, 0.05, p)!
    expect(m.canopyBlockedFraction).toBeGreaterThan(0)
    expect(m.canopyClearanceMin).toBeLessThan(0)
  })
})

describe('anchor zone', () => {
  /**
   * The flat span sampled every metre, with a mound raised over the samples from `from` to `to`.
   *
   * Finer than the other fixtures here on purpose: the anchor zone is ten metres, so at the usual
   * five-metre spacing it holds two samples and one of them sits on the anchor itself.
   */
  const mound = (from: number, to: number, top: number) =>
    packProfile(
      flatSpan(50, 20, 200, 1).map((sm) => (sm.d >= from && sm.d <= to ? { ...sm, ground: top } : sm)),
      p,
    )

  const at = (sp: ReturnType<typeof mound>) => rawMetricsAt(sp, 200, 50, 50, 0.05, p)!

  it('is zero for a line that stays above ground near its anchors', () => {
    expect(at(mound(0, 0, 20)).anchorZoneDeficit).toBe(0)
  })

  it('reports how deep the line runs inside a mound beside the anchor', () => {
    // A mound 5 m past the anchor, standing well above where the line is by then.
    const m = at(mound(4, 8, 60))
    expect(m.anchorZoneDeficit).toBeGreaterThan(0)
    // Still a candidate: nothing inside the zone disqualifies a line.
    expect(rejectionOf(m, p)).toBeNull()
  })

  it('costs score without costing candidacy', () => {
    const clean = at(mound(0, 0, 20))
    const buried = at(mound(4, 8, 60))
    expect(violationsOf(buried, 200, 0, p)).toEqual([])
    expect(scoreOf(200, 0, buried, p).score).toBeLessThan(scoreOf(200, 0, clean, p).score)
    // A nudge, not a verdict: the clearance component is 5 points of the hundred.
    expect(scoreOf(200, 0, clean, p).score - scoreOf(200, 0, buried, p).score).toBeLessThan(6)
  })

  it('weights a burial at the far edge of the zone above one at the anchor', () => {
    const near = at(mound(1, 3, 60)).anchorZoneDeficit
    const far = at(mound(7, 9, 60)).anchorZoneDeficit
    expect(far).toBeGreaterThan(near)
  })
})

describe('scoreOf', () => {
  const base: Metrics = {
    clearanceMin: 5, clearanceMargin: 2, clearanceMarginAt: 100, clearanceMarginNeeded: 3,
    exposure: 20, canopyClearanceMin: 2,
    canopyBlockedFraction: 0, clearanceDeficit: 0, anchorZoneDeficit: 0, crossingDeficit: 0,
    worstCrossing: -1, worstClearance: Infinity,
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
      p,
    )
  const measure = (sp: ReturnType<typeof withBump>) =>
    rawMetricsAt(sp, 200, 50, 50, 0.05, p)!

  it('costs a line that qualifies nothing at all', () => {
    const m = metricsAt(packProfile(flatSpan(), p), 200, 50, 50, 0.05, p)!
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
    const clean = metricsAt(packProfile(flatSpan(), p), 200, 50, 50, 0.05, p)!
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

describe('violationsOf', () => {
  const at = (clearanceMin: number): Metrics => ({
    clearanceMin, clearanceMargin: clearanceMin - p.minClearance,
    clearanceMarginAt: 100, clearanceMarginNeeded: p.minClearance, exposure: 40,
    canopyClearanceMin: 5, canopyBlockedFraction: 0, clearanceDeficit: 0, anchorZoneDeficit: 0,
    crossingDeficit: 0, worstCrossing: -1, worstClearance: Infinity,
  })

  it('sends the reader to the sample that failed, not the one that looks worst', () => {
    /**
     * A span over a lake with a bank at the far end. The tightest gap is over the water and passes:
     * a metre is all it owes there. The failure is on land ten metres from the anchor, owing three
     * and clearing 2.35, and a message quoting only the shortfall had the reader looking at the
     * lake -- which is what 434780.5_5805692.5__434572.5_5805869.5 does in the shipped dataset.
     */
    const overLake: Metrics = {
      ...at(1.02), clearanceMargin: -0.65, clearanceMarginAt: 263, clearanceMarginNeeded: 3,
    }
    const said = violationsOf(overLake, 273.1, 0, p).join(' ')
    expect(said).toMatch(/0\.65 m short at 263 m, where it owes 3 m over ground/)
    // The 1.02 m over the water is not quoted, because it is not the problem.
    expect(said).not.toMatch(/1\.02/)
  })

  it('names water as water, since a metre is the whole rule there', () => {
    const overWater: Metrics = {
      ...at(0.8), clearanceMargin: -0.2, clearanceMarginAt: 140, clearanceMarginNeeded: p.waterClearance,
    }
    expect(violationsOf(overWater, 273.1, 0, p).join(' ')).toMatch(
      /0\.20 m short at 140 m, where it owes 1 m over water/,
    )
  })

  it('never prints a figure at float precision', () => {
    /**
     * "under the 1.240000000000009 m minimum" reached the panel, from subtracting two rounded
     * metrics and formatting the result raw. Every figure here is read by a person, so none of them
     * has any business carrying more than a couple of decimals.
     */
    const nasty: Metrics = {
      ...at(1.04), clearanceMargin: -0.2000000000000009, exposure: 0.1 + 0.2,
      canopyBlockedFraction: 0.8100000000000001, crossingDeficit: 3, worstCrossing: 0,
      worstClearance: 1.1000000000000005,
    }
    const said = violationsOf(nasty, 40.000000000001, 9.100000000000001, p, [
      { d: 20.5, from: 18, to: 23, offset: 0.30000000000000004, kind: 'path', tier: 'path', onBridge: false },
    ] as never)
    expect(said.length).toBeGreaterThan(3)
    for (const line of said) expect(line).not.toMatch(/\d\.\d{3,}/)
  })

  it('quotes the shortfall when the line is merely too low', () => {
    // The shortfall, not a clearance beside a requirement: 1.4 m against the 3 m minimum is 1.6 m
    // short, and that figure belongs to one station rather than being the difference of two minima
    // taken at different ones.
    expect(violationsOf(at(1.4), 200, 0, p).join(' ')).toMatch(
      /comes 1\.60 m short at 100 m, where it owes 3 m over ground/,
    )
  })

  it('says the line is in the ground rather than quoting a negative clearance', () => {
    // "Clears the ground by only -2.6 m" is arithmetic, not a description of anything.
    const said = violationsOf(at(-2.6), 200, 0, p).join(' ')
    expect(said).toContain('intersects the ground')
    expect(said).not.toMatch(/-2\.6/)
  })
})

describe('road crossings', () => {
  /**
   * The flat span, with the line 20 m over the floor at midspan once the sag is applied. Anything
   * demanding more than that is a crossing the line cannot make.
   */
  const packed = packProfile(flatSpan(), p)
  const cross = (tier: 'path' | 'street' | 'highway', extra: Partial<Crossing> = {}): Crossing => ({
    d: 100, from: 96, to: 104, offset: 0, kind: 'test', tier, onBridge: false, ...extra,
  })
  const at = (crossings: Crossing[]) => rawMetricsAt(packed, 200, 50, 50, 0.05, p, crossings)!

  it('costs nothing where the class asks for nothing beyond the base clearance', () => {
    const m = at([cross('path')])
    expect(m.crossingDeficit).toBe(0)
    expect(m.worstCrossing).toBe(0)
    // A footpath demands the 3 m every line owes, and there are 20 m here.
    expect(m.worstClearance).toBeGreaterThan(p.minClearance)
  })

  it('reports the shortfall when the class asks for more air than there is', () => {
    const m = at([cross('highway')])
    // 23 m demanded against the 20 m the line actually has.
    expect(m.crossingDeficit).toBeCloseTo(3, 1)
    expect(violationsOf(m, 200, 0, p, [cross('highway')]).join(' ')).toMatch(
      /passes 20.0 m over a test at 100 m, under the 23 m it needs/,
    )
    expect(penaltyOf(m, 200, 0, p)).toBeGreaterThan(0)
  })

  it('rejects the line outright, the way terrain clearance does', () => {
    expect(metricsAt(packed, 200, 50, 50, 0.05, p, [cross('street')])).not.toBeNull()
    expect(metricsAt(packed, 200, 50, 50, 0.05, p, [cross('highway')])).toBeNull()
  })

  it('reports the tightest crossing rather than the first', () => {
    const m = at([cross('path'), cross('highway', { d: 60, from: 56, to: 64 })])
    expect(m.worstCrossing).toBe(1)
  })

  it('measures a bridge against the deck rather than the ground beneath it', () => {
    // A deck 15 m over the floor leaves only 5 m of air, where the ground would have said 20.
    const decked = packProfile(
      flatSpan().map((sm) => (sm.d >= 90 && sm.d <= 110 ? { ...sm, surface: 35 } : sm)),
      p,
    )
    const onGround = rawMetricsAt(decked, 200, 50, 50, 0.05, p, [cross('street')])!
    const onDeck = rawMetricsAt(decked, 200, 50, 50, 0.05, p, [cross('street', { onBridge: true })])!
    expect(onGround.crossingDeficit).toBe(0)
    expect(onDeck.worstClearance).toBeCloseTo(5, 1)
    expect(onDeck.crossingDeficit).toBeCloseTo(6, 1)
  })

  it('finds a road narrower than the profile spacing, by probing the ends of its stretch', () => {
    // A hump under one end only, between two samples: checking the tightest point alone would miss
    // it.
    const humped = packProfile(
      flatSpan().map((sm) => (sm.d === 105 ? { ...sm, ground: 38 } : sm)),
      p,
    )
    const m = rawMetricsAt(humped, 200, 50, 50, 0.05, p, [
      cross('street', { d: 101, from: 97, to: 105 }),
    ])!
    expect(m.worstClearance).toBeLessThan(5)
    expect(m.crossingDeficit).toBeGreaterThan(0)
  })

  it('measures a crossing against the road rather than the ground under the line', () => {
    // The floor is at 20 m and the line 20 m over it. A road on an embankment at 32 m has only 8 m,
    // and reading the profile under the line instead would report the full 20 and pass it.
    const m = at([cross('street', { carrier: 32 })])
    expect(m.worstClearance).toBeCloseTo(8, 1)
    expect(m.crossingDeficit).toBeCloseTo(3, 1)
  })

  it('does not charge a road for a building standing beside it', () => {
    // A band full of building -- 25 m over the floor, and above the sagging line -- with a street
    // underneath at floor level. The building is a clearance problem in its own right and is counted
    // as one; the street's requirement is still measured from the street.
    const beside = { ...packed, groundMax: packed.ground.map((g) => (g === 20 ? 45 : g)) }
    const m = rawMetricsAt(beside, 200, 50, 50, 0.05, p, [cross('street', { carrier: 20 })])!
    expect(m.clearanceMin).toBeLessThan(0)
    expect(m.worstClearance).toBeCloseTo(20, 1)
    expect(m.crossingDeficit).toBe(0)
  })

  it('shrinks the feasible sag, since more sag is less air over the road', () => {
    const free = maxFeasibleSag(packed, 200, 50, 50, p)
    const roaded = maxFeasibleSag(packed, 200, 50, 50, p, [cross('street')])
    expect(roaded).toBeLessThan(free)
    expect(roaded).toBeGreaterThan(0)
  })
})

describe('rescoreAtSag', () => {
  const profile = flatSpan()
  const packed = packProfile(profile, p)
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
    const samples = unpackProfile(c.profile!, c.length, c.a.anchor, c.b.anchor, sagRatio, p)
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
    const samples = unpackProfile(sp, length, hA, hB, sagRatio, p)
    const inner0 = p.anchorZone
    const inner1 = length - p.anchorZone
    let clearanceMin = Infinity
    let clearanceMargin = Infinity
    let clearanceMarginAt = NaN
    let clearanceMarginNeeded = NaN
    let exposure = -Infinity
    let canopyClearanceMin = Infinity
    let blocked = 0
    let n = 0
    let deficit = 0
    let weight = 0
    let zoneDeficit = 0
    let zoneWeight = 0
    for (const s of samples) {
      const clear = s.line - s.ground
      if (clear > exposure) exposure = clear
      const central = Math.min(s.d, length - s.d) / (length / 2)
      if (s.d < inner0 || s.d > inner1) {
        zoneDeficit += central * Math.max(0, s.groundMax - s.line)
        zoneWeight += central
        continue
      }
      if (clear < clearanceMin) clearanceMin = clear
      if (clear - s.needed < clearanceMargin) {
        clearanceMargin = clear - s.needed
        clearanceMarginAt = s.d
        clearanceMarginNeeded = s.needed
      }
      const canopy = s.line - s.surface
      if (canopy < canopyClearanceMin) canopyClearanceMin = canopy
      if (canopy < 0) blocked++
      weight += central
      if (clear < p.minClearance) deficit += central * (p.minClearance - clear)
      n++
    }
    return {
      clearanceMin,
      clearanceMargin,
      clearanceMarginAt,
      clearanceMarginNeeded,
      exposure,
      canopyClearanceMin,
      canopyBlockedFraction: blocked / n,
      clearanceDeficit: weight > 0 ? deficit / weight : 0,
      anchorZoneDeficit: zoneWeight > 0 ? zoneDeficit / zoneWeight : 0,
      // This reference walks the profile alone; crossings come from the road network and are
      // measured separately, so with none passed in these are what the real one must report.
      crossingDeficit: 0,
      worstCrossing: -1,
      worstClearance: Infinity,
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


describe('a profile with stations the survey never covered', () => {
  /**
   * The viewer now measures a partly covered line rather than refusing it, so NaN ground reaches
   * here. Skipping a station whole is not the same as letting its comparisons fall through: every
   * comparison against NaN is false, so it never lowered a minimum and never counted as blocked,
   * while still adding to the weight the clearance deficit is averaged over. An unsurveyed stretch
   * therefore read as perfectly clear air and diluted the charge for the ground that was seen.
   */
  const dipped = flatSpan(50, 20, 200, 2).map((sm) =>
    sm.d > 55 && sm.d < 85 ? { ...sm, ground: 47, groundMax: 47, surface: 47, surfaceMax: 47 } : sm)
  const blanked = (lo: number, hi: number) =>
    packProfile(
      dipped.map((sm) =>
        sm.d > lo && sm.d < hi
          ? { ...sm, ground: NaN, groundMax: NaN, surface: NaN, surfaceMax: NaN }
          : sm),
      p,
    )
  const metrics = (sp: ReturnType<typeof blanked>) => rawMetricsAt(sp, 200, 50, 50, 0.05, p)!

  it('charges the ground it saw for the whole of what it saw', () => {
    // The gap covers clear ground well away from the dip, so the dip is now a larger share of what
    // was measured and has to be charged as one. Left to fall through, the gap kept its weight with
    // nothing behind it and the charge came out lower instead.
    const whole = metrics(blanked(0, 0))
    const holed = metrics(blanked(120, 170))
    expect(holed.clearanceDeficit).toBeGreaterThan(whole.clearanceDeficit)
  })

  it('reads the same figures however much clear ground around it is missing', () => {
    // Widening a gap over ground that was never the worst of anything changes nothing it reports.
    for (const wide of [metrics(blanked(120, 150)), metrics(blanked(115, 170))]) {
      expect(wide.clearanceMin).toBeCloseTo(metrics(blanked(120, 170)).clearanceMin, 6)
      expect(wide.exposure).toBeCloseTo(metrics(blanked(120, 170)).exposure, 6)
    }
  })
})


describe('rescoring a dataset line for display', () => {
  /**
   * A line that clears the ground by less than it is held to, which is what a finer re-measurement
   * of a marginal candidate produces. 434780.5_5805692.5__434572.5_5805869.5 in the shipped dataset
   * clears by 1.04 m where open water requires 1.00 -- four centimetres of margin, and the viewer
   * measures every metre where the search measured every four.
   */
  const tight = (): Candidate => {
    const span = flatSpan(50, 20, 200, 2).map((sm) =>
      sm.d > 90 && sm.d < 110 ? { ...sm, ground: 69, groundMax: 69, surface: 69, surfaceMax: 69 } : sm)
    return {
      id: 'tight', kind: 'natural',
      a: { lat: 0, lon: 0, e: 0, n: 0, ground: 50, anchor: 70, aFrame: 0 },
      b: { lat: 0, lon: 0, e: 200, n: 0, ground: 50, anchor: 70, aFrame: 0 },
      length: 200, bearing: 90, sag: 10, offLevel: 0, offLevelRatio: 0,
      clearanceMin: 1, exposure: 20, canopyClearanceMin: 1, canopyBlockedFraction: 0,
      score: 50, scoreParts: { exposure: 0, length: 0, canopy: 0, margin: 0, level: 0 },
      maxSagRatio: 0.05, crossings: [], profile: packProfile(span, p),
    } as unknown as Candidate
  }

  it('drops out of the filtered list, which is what the list is for', () => {
    expect(rescoreAtSag(tight(), 0.05, p)).toBeNull()
  })

  it('still comes back with its profile and its figures, so the panel can draw it', () => {
    const out = rescoreForDisplay(tight(), 0.05, p)
    expect(out).not.toBeNull()
    // The whole bug: this used to be null, the panel fell back to a candidate carrying no profile,
    // and the chart waited on elevation that was never coming.
    expect(out!.candidate.profile).toBeTruthy()
    expect(Number.isFinite(out!.candidate.clearanceMin)).toBe(true)
    expect(out!.violations.length).toBeGreaterThan(0)
  })

  it('says nothing is wrong with a line that clears everything', () => {
    const fine = { ...tight(), profile: packProfile(flatSpan(50, 20, 200, 2), p) }
    expect(rescoreForDisplay(fine, 0.05, p)!.violations).toEqual([])
  })
})
