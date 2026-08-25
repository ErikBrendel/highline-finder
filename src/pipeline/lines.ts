import type { Grid, Pos } from '../shared/grid.js'
import { bearingOf, oppositeBearing, sectorOf, toWgs84 } from '../shared/geo.js'
import type { Anchor } from './openness.js'
import type { Endpoint } from './hotspots.js'
import type { AnchorOut, Candidate, Params } from '../shared/types.js'
import {
  chooseHeights,
  lineHeightAt,
  maxFeasibleSag,
  rawMetricsAt,
  rejectionOf,
  rescoreAtSag,
  type Reject,
} from '../shared/scoring.js'
import { lineKind, rigRange } from '../shared/anchoring.js'
import type { Scene } from '../shared/scene.js'
import { clearanceNeeded, type WaterCover } from '../shared/water.js'
import { canopyProfile, groundProfile, trimProfile } from '../shared/profile.js'

/**
 * Stages 3-5: pair anchors, choose attachment heights, test the span, score and deduplicate.
 *
 * Offlevel. A line whose two ends sit at different heights is harder to rig, walks unevenly and
 * loads the lower anchor more, so the height difference is capped at `maxOffLevelRatio` of the
 * span -- 1 m over 50 m, 10 m over 500 m -- as a hard constraint. Without it the search happily
 * proposes lines tilted by tens of metres, which are geometrically fine and practically useless.
 *
 * Because an anchor has a *range* of usable attachment heights rather than one, the cap is not
 * simply a test on the terrain: see chooseHeights.
 *
 * Line geometry. The line is the chord between the two chosen attachment points, pulled down by a
 * parabolic sag with its maximum at midspan:
 *
 *     height(t) = lerp(hA, hB, t) - 4 * sag * t * (1 - t),   sag = sagRatio * length
 *
 * This is a stand-in, not a model. Real sag depends on webbing, tension and where the walker is
 * standing, and the worst case is not always midspan. A constant fraction of span is close
 * enough to rank candidates against each other and wrong enough that no rigging decision should
 * rest on it. See ROADMAP for the catenary replacement.
 *
 * Clearance is measured only on the interior of the span, outside `anchorZone` at each end. At an
 * anchor the line may sit at ground level, so a whole-span requirement would reject everything.
 *
 * Terrain is a hard filter, canopy is only scored. That is a deliberate project decision: bare
 * terrain clearance is geometry and is trustworthy, whereas the canopy layer carries a 21-month
 * epoch mismatch and photogrammetric noise, and vegetation can be worked around in ways terrain
 * cannot. The consequence is that a long result list is not a list of walkable lines -- in closed
 * forest most candidates will have a high canopyBlockedFraction. That column is the real filter,
 * and the score weights it accordingly.
 */

/**
 * Cheap gate used during the pair search: does the line clear the terrain at all, and does it get
 * far enough off the ground to count?
 *
 * Walks the raster directly at `profileStep`, which is finer than the emitted profile, and bails
 * the instant the terrain requirement is violated. That early exit is what makes the search
 * affordable -- the overwhelming majority of pairs die at the midspan check, before any profile is
 * built. The authoritative metrics are recomputed afterwards from the emitted profile, so this only
 * has to be a filter, not a measurement.
 *
 * The clearance it demands is read per sample from the water layer, not fixed. A prefilter may only
 * reject what the real test would also reject, and the real test asks less over open water -- so a
 * flat ground figure here would delete every line over a lake before the water layer was consulted.
 * Assuming the loosest figure everywhere instead is safe but ruinous: it waves through every line
 * with one to three metres of air over dry Brandenburg, and measured on region 2 that put nine and
 * a half times as many pairs into the banded profile stage and tripled the run.
 *
 * Reading water on the centreline is deliberately more permissive than the real rule, which wants
 * the whole band over water before it discounts anything. More permissive is the safe direction for
 * a prefilter, and it costs one bitmask lookup per step. The band itself needs no such care: it
 * only ever finds more obstruction than the centreline, so the thin walk stays a superset.
 */
function clearsTerrain(
  a: Pos,
  b: Pos,
  hA: number,
  hB: number,
  length: number,
  ground: Grid,
  p: Params,
  water?: WaterCover | null,
): boolean {
  const sag = p.sagRatio * length
  const de = (b.e - a.e) / length
  const dn = (b.n - a.n) / length
  const inner0 = p.anchorZone
  const inner1 = length - p.anchorZone
  if (inner1 <= inner0) return false
  const needAt = (e: number, n: number) => clearanceNeeded(water?.covers(e, n) ?? false, p)

  // The deepest sag sits at midspan, so that is where a line most often meets the ground.
  const mid = length / 2
  const me = a.e + de * mid
  const mn = a.n + dn * mid
  if (lineHeightAt(hA, hB, sag, 0.5) - ground.sample(me, mn) < needAt(me, mn)) return false

  let exposure = -Infinity
  for (let d = 0; d <= length; d += p.profileStep) {
    const e = a.e + de * d
    const n = a.n + dn * d
    const g = ground.sample(e, n)
    if (Number.isNaN(g)) return false
    const clear = lineHeightAt(hA, hB, sag, d / length) - g
    if (clear > exposure) exposure = clear
    if (d >= inner0 && d <= inner1 && clear < needAt(e, n)) return false
  }
  return exposure >= p.minExposure
}

/**
 * What a pair of positions turned out to be: a candidate, or the reason it was not one.
 *
 * The reason is reported rather than discarded because the pipeline draws where lines are dying and
 * to what. A filter whose cost is invisible is a filter nobody can tune, and the clearance ladder
 * over traffic is a stack of judgement calls waiting for that evidence.
 */
export interface Evaluated {
  line: Candidate | null
  reject: Reject | 'geometry' | 'length' | 'offlevel' | 'terrain' | null
  /** Where the failure is, when it has a place: the crossing, for a line that passes too low. */
  at: Pos | null
}

const failed = (reject: Evaluated['reject'], at: Pos | null = null): Evaluated => ({
  line: null,
  reject,
  at,
})

export interface FindResult {
  /** Deduplicated but not capped; run.ts refines and caps. */
  candidates: Candidate[]
  /**
   * Both anchors of every feasible line, before dedup, with the canopy figure the hotspot layer
   * filters on. Kept as bare positions because the full candidates would be tens of thousands of
   * 120-sample profiles; density is exactly what dedup destroys.
   */
  endpoints: Endpoint[]
  pairsInRange: number
  pairsSectorPassed: number
  pairsLevelEnough: number
  pairsFeasible: number
  candidatesAfterDedup: number
  /** How many pairs each hard constraint rejected, and where the road ones were. */
  rejects: Record<string, number>
  /** Positions of lines killed by a road crossing, so the map can show which roads are doing it. */
  roadKills: Pos[]
}

/**
 * Builds the full candidate for a pair of positions, or null if it fails any hard constraint.
 *
 * Positions are free-floating rather than taken from the anchor lattice, because the refinement
 * pass moves them off it. Terrain heights come from the grid rather than from the Anchor records
 * for the same reason: this is the single place that decides what a line at two coordinates is
 * worth, so the search and the refinement cannot drift apart.
 *
 * Anchor ground heights are read from the containing cell, not interpolated. Anchors sit at cliff
 * edges by their nature, and interpolating there averages the rim with the drop beside it and puts
 * the anchor metres below where it really is. The profile between them does interpolate, since
 * there the point is a smooth section rather than one specific spot.
 */
export function evaluateLine(
  a: Pos,
  b: Pos,
  ground: Grid,
  surface: Grid,
  p: Params,
  /**
   * The city model, which decides both how a line may attach and what kind of line it is, and the
   * road network, which decides how much air it owes what it passes over. Empty measures bare
   * elevation, as the unit tests do.
   */
  scene: Scene = {},
  /**
   * Set when the caller has already run the terrain gate on this exact pair, which the pair search
   * has: repeating it costs a full raster walk per surviving line and cannot change the answer.
   */
  terrainAlreadyChecked = false,
): Evaluated {
  const gA = ground.nearest(a.e, a.n)
  const gB = ground.nearest(b.e, b.n)
  if (Number.isNaN(gA) || Number.isNaN(gB)) return failed('geometry')

  const dE = b.e - a.e
  const dN = b.n - a.n
  const length = Math.hypot(dE, dN)
  if (length < p.minLength || length > p.maxLength) return failed('length')

  const onRoofA = scene.roofs?.covers(a.e, a.n) ?? false
  const onRoofB = scene.roofs?.covers(b.e, b.n) ?? false
  const rangeA = rigRange(onRoofA, p)
  const rangeB = rigRange(onRoofB, p)
  const h = chooseHeights(
    gA + rangeA.min,
    gA + rangeA.max,
    gB + rangeB.min,
    gB + rangeB.max,
    p.maxOffLevelRatio * length,
  )
  if (!h) return failed('offlevel')

  if (!terrainAlreadyChecked && !clearsTerrain(a, b, h.hA, h.hB, length, ground, p, scene.water)) {
    return failed('terrain')
  }

  // Round the scalars before anything is measured from them. The web app re-derives every
  // clearance from these serialised values, so measuring from the full-precision ones would let
  // the dataset contain candidates the UI immediately rejects -- a line whose clearance is exactly
  // at minClearance flips either side of the boundary on the last decimal.
  const crossings = scene.roads?.crossings(a, b, p, { ground, surface })
  const r2 = (v: number) => Math.round(v * 100) / 100
  const roundedLength = Math.round(length * 10) / 10
  const hA = r2(h.hA)
  const hB = r2(h.hB)
  const bearing = bearingOf(dE, dN)

  // Latitude and longitude are left unset here and filled in by `locate` once the line is known to
  // be worth keeping. Projecting is two proj4 transforms, which over two million feasible lines is
  // twenty seconds spent on coordinates that dedup is about to discard.
  const provisional: Candidate = {
    id: `${a.e.toFixed(1)}_${a.n.toFixed(1)}__${b.e.toFixed(1)}_${b.n.toFixed(1)}`,
    kind: lineKind(onRoofA, onRoofB),
    a: { lat: NaN, lon: NaN, e: a.e, n: a.n, ground: r2(gA), anchor: hA, aFrame: r2(hA - gA) },
    b: { lat: NaN, lon: NaN, e: b.e, n: b.n, ground: r2(gB), anchor: hB, aFrame: r2(hB - gB) },
    length: roundedLength,
    bearing: Math.round(((bearing * 180) / Math.PI) * 10) / 10,
    sag: 0,
    offLevel: r2(h.offLevel),
    offLevelRatio: Math.round((h.offLevel / roundedLength) * 10000) / 10000,
    clearanceMin: 0,
    exposure: 0,
    canopyClearanceMin: 0,
    canopyBlockedFraction: 0,
    score: 0,
    scoreParts: { exposure: 0, length: 0, canopy: 0, margin: 0, level: 0 },
    maxSagRatio: 0,
    crossings,
  }

  /**
   * Terrain first, and gated on it, before the surface model is touched at all.
   *
   * Everything except canopy is decided by the terrain, and better than seven in ten pairs that get
   * here fail one of those tests -- so the surface samples, the canopy band and the metrics that
   * read them are work spent on a verdict already reached. Standing in for the surface with the
   * terrain itself is what lets one call to `rejectionOf` serve both passes: with nothing above the
   * ground, the canopy gate cannot trip, so this asks exactly the questions terrain can answer.
   */
  const terrain = groundProfile(a, b, roundedLength, ground, p, scene)
  const probe = { ...terrain, surface: terrain.ground }
  const early = rawMetricsAt(probe, roundedLength, hA, hB, p.sagRatio, p, crossings)
  if (!early) return failed('geometry')
  const earlyReject = rejectionOf(early, p)
  if (earlyReject) {
    const worst = earlyReject === 'crossing' ? crossings?.[early.worstCrossing] : undefined
    const t = worst ? worst.d / roundedLength : 0
    return failed(earlyReject, worst ? { e: a.e + dE * t, n: a.n + dN * t } : null)
  }

  // The canopy band is drawn rather than scored, so the search never pays for it. A profile that is
  // going to be stored, or one the browser builds for a line being looked at, gets the full thing.
  const canopy = canopyProfile(a, b, roundedLength, surface, terrain, p, p.storeProfiles)
  provisional.profile = { ...terrain, ...canopy }

  const m = rawMetricsAt(provisional.profile, roundedLength, hA, hB, p.sagRatio, p, crossings)
  if (!m) return failed('geometry')
  const reject = rejectionOf(m, p)
  if (reject) return failed(reject)

  provisional.maxSagRatio = maxFeasibleSag(
    provisional.profile!, roundedLength, hA, hB, p, provisional.crossings,
  )

  // Every measured field is filled in by the same function the web app uses, so the two cannot
  // disagree. It re-measures, which is one pass over the profile for a line already known to keep.
  const scored = rescoreAtSag(provisional, p.sagRatio, p)

  /**
   * The profile is dropped here unless it is going to be written out.
   *
   * Nothing downstream reads it -- refinement re-measures from the raster and dedup compares
   * anchors -- so on a run that stores no profiles it is half a million arrays held from the moment
   * they stop being useful until the pooled results are written. That was already over a gigabyte
   * before the band added three more series to each of them, which is what finally ran the heap
   * out. Trimmed rather than kept whole when it *is* wanted, so the optional series still cost
   * nothing when they say nothing.
   */
  if (!scored) return failed('geometry')
  const { profile, ...bare } = scored
  return {
    line: p.storeProfiles ? { ...bare, profile: trimProfile(profile!, p) } : bare,
    reject: null,
    at: null,
  }
}

export interface TerrainPairs {
  /** Anchor pairs whose line clears the terrain. A superset of the feasible set. */
  pairs: [Pos, Pos][]
  pairsInRange: number
  pairsSectorPassed: number
  pairsLevelEnough: number
}

/**
 * The pair search, up to but not including anything that needs the surface model.
 *
 * Split out because the surface model is 33 MB per square kilometre against the terrain model's
 * 1.4 MB, and canopy is never a gate -- only a score. So the corridors worth paying for are exactly
 * the ones a line already crosses, and those cannot be known until this pass has run. Everything
 * here reads `ground` alone.
 */
export function terrainPairs(
  anchors: Anchor[],
  ground: Grid,
  p: Params,
  /** For the water layer, which decides how much air each sample of the gate is held to. */
  scene: Scene = {},
): TerrainPairs {
  let pairsInRange = 0
  let pairsSectorPassed = 0
  let pairsLevelEnough = 0
  const pairs: [Pos, Pos][] = []

  /**
   * Anchors bucketed on a lattice of `maxLength`, so only the nine buckets around one anchor can
   * hold a partner in range.
   *
   * The plain double loop was fine at a square kilometre and is not at a hundred: pairs *in range*
   * grow linearly with area while the loop grows quadratically, so almost all of its work became
   * rejecting anchors kilometres apart. Bucketing makes the enumeration output-sensitive, and it is
   * exact rather than approximate -- two points within maxLength cannot land more than one bucket
   * apart on a lattice of that size.
   */
  const buckets = new Map<string, number[]>()
  const cell = p.maxLength
  const keyOf = (e: number, n: number) => `${Math.floor(e / cell)}_${Math.floor(n / cell)}`
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i]!
    const key = keyOf(a.e, a.n)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(i)
    else buckets.set(key, [i])
  }

  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i]!
    const cx = Math.floor(a.e / cell)
    const cy = Math.floor(a.n / cell)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of buckets.get(`${cx + dx}_${cy + dy}`) ?? []) {
          // Each unordered pair is visited once, exactly as the double loop did.
          if (j <= i) continue
          const b = anchors[j]!
          const dE = b.e - a.e
          const dN = b.n - a.n
          const length = Math.hypot(dE, dN)
          if (length < p.minLength || length > p.maxLength) continue
          pairsInRange++

          const bearing = bearingOf(dE, dN)
          if (!a.open[sectorOf(bearing, p.sectorCount)]) continue
          if (!b.open[sectorOf(oppositeBearing(bearing), p.sectorCount)]) continue
          pairsSectorPassed++

          // Cheap pre-check on the same rule evaluateLine will apply, so the offlevel funnel stays
          // observable in the logs instead of hiding inside the profile rejection count.
          const h = chooseHeights(
            a.anchorMin,
            a.anchorMax,
            b.anchorMin,
            b.anchorMax,
            p.maxOffLevelRatio * length,
          )
          if (!h) continue
          pairsLevelEnough++

          if (clearsTerrain(a, b, h.hA, h.hB, length, ground, p, scene.water)) pairs.push([a, b])
        }
      }
    }
  }
  return { pairs, pairsInRange, pairsSectorPassed, pairsLevelEnough }
}

/** Fills in the WGS84 coordinates a candidate carries for display. */
export function locate(c: Candidate): Candidate {
  return {
    ...c,
    a: { ...c.a, ...toWgs84(c.a.e, c.a.n) },
    b: { ...c.b, ...toWgs84(c.b.e, c.b.n) },
  }
}

/** Scores terrain-passing pairs against the surface model, and collapses near-duplicates. */
export function evaluatePairs(
  found: TerrainPairs,
  ground: Grid,
  surface: Grid,
  p: Params,
  scene: Scene = {},
): FindResult {
  const feasible: Candidate[] = []
  const endpoints: Endpoint[] = []
  const rejects: Record<string, number> = {}
  const roadKills: Pos[] = []
  for (const [a, b] of found.pairs) {
    const { line: c, reject, at } = evaluateLine(a, b, ground, surface, p, scene, true)
    if (!c) {
      if (reject) rejects[reject] = (rejects[reject] ?? 0) + 1
      if (at) roadKills.push(at)
      continue
    }
    feasible.push(c)
    // Both ends carry the *line's* kind, not their own: the hotspot layer answers "what could be
    // rigged from here", and for a mixed line that is a mixed line at either end of it.
    endpoints.push(
      { e: c.a.e, n: c.a.n, kind: c.kind, score: c.score, blocked: c.canopyBlockedFraction },
      { e: c.b.e, n: c.b.n, kind: c.kind, score: c.score, blocked: c.canopyBlockedFraction },
    )
  }

  const candidates = dedupe(feasible, p.dedupRadius)
  return {
    candidates,
    endpoints,
    pairsInRange: found.pairsInRange,
    pairsSectorPassed: found.pairsSectorPassed,
    pairsLevelEnough: found.pairsLevelEnough,
    pairsFeasible: feasible.length,
    candidatesAfterDedup: candidates.length,
    rejects,
    roadKills,
  }
}

/** Both passes in one, for callers that already hold both rasters. */
export function findLines(
  anchors: Anchor[],
  ground: Grid,
  surface: Grid,
  p: Params,
  scene: Scene = {},
): FindResult {
  return evaluatePairs(terrainPairs(anchors, ground, p, scene), ground, surface, p, scene)
}

/** Offsets within `radius`, on a `step` lattice, ordered outward. Excludes the origin. */
function neighbourhood(radius: number, step: number): Pos[] {
  const out: Pos[] = []
  const k = Math.floor(radius / step)
  for (let i = -k; i <= k; i++) {
    for (let j = -k; j <= k; j++) {
      const e = i * step
      const n = j * step
      if ((e === 0 && n === 0) || e * e + n * n > radius * radius) continue
      out.push({ e, n })
    }
  }
  return out.sort((x, y) => x.e * x.e + x.n * x.n - (y.e * y.e + y.n * y.n))
}

export interface RefineResult {
  candidates: Candidate[]
  improved: number
  totalGain: number
  evaluations: number
}

/**
 * Hill-climbs each candidate's two anchors to a local score maximum.
 *
 * The anchor lattice is `anchorStep` metres coarse, so every reported anchor can be up to half a
 * step away from the position that actually works best. This pass recovers that: each end is moved
 * independently over a `refineStep` lattice, capped at `refineRadius` from where it started, and
 * the pair of positions with the best score wins. A radius of at least half `anchorStep` is what
 * makes the original quantisation stop mattering.
 *
 * Coordinate descent -- move A to its best position with B fixed, then B with A fixed, repeat --
 * because the two ends interact: raising one end changes the offlevel budget and hence the height
 * the other end may use. Displacement is always measured from the *original* position, so the caps
 * hold no matter how many passes run and the search cannot drift away across iterations.
 *
 * Runs after deduplication rather than before, on hundreds of candidates instead of tens of
 * thousands. Refining everything first would be more thorough and roughly a hundred times slower.
 */
export function refine(
  candidates: Candidate[],
  ground: Grid,
  surface: Grid,
  p: Params,
  scene: Scene = {},
): RefineResult {
  if (p.refineRadius <= 0) {
    return { candidates, improved: 0, totalGain: 0, evaluations: 0 }
  }
  const offsets = neighbourhood(p.refineRadius, p.refineStep)
  let improved = 0
  let totalGain = 0
  let evaluations = 0

  const out = candidates.map((start) => {
    const origin = [
      { e: start.a.e, n: start.a.n },
      { e: start.b.e, n: start.b.n },
    ] as const
    let best = start

    for (let pass = 0; pass < p.refineIterations; pass++) {
      const before = best.score

      for (const end of [0, 1] as const) {
        const fixed = end === 0 ? { e: best.b.e, n: best.b.n } : { e: best.a.e, n: best.a.n }
        for (const off of offsets) {
          const moved = { e: origin[end].e + off.e, n: origin[end].n + off.n }
          const { line: c } = end === 0
            ? evaluateLine(moved, fixed, ground, surface, p, scene)
            : evaluateLine(fixed, moved, ground, surface, p, scene)
          evaluations++
          if (c && c.score > best.score) best = c
        }
      }

      if (best.score <= before) break
    }

    if (best !== start) {
      improved++
      totalGain += best.score - start.score
    }
    return best
  })

  return { candidates: out, improved, totalGain, evaluations }
}

/**
 * Collapses near-identical lines, keeping the best-scoring one.
 *
 * Two candidates are the same line when *both* endpoints are within `radius` of each other, in
 * either orientation -- sharing only one endpoint makes them genuinely different lines fanning out
 * from a common anchor, which is worth seeing.
 *
 * Greedy suppression in score order rather than quantising endpoints onto a grid. Grid cells are
 * cheaper but have a boundary artefact: two anchors a metre apart on opposite sides of a cell edge
 * land in different buckets and both survive, which is exactly the duplicate this is meant to
 * remove. Note that `radius` interacts with `anchorStep`: at or below the anchor spacing it only
 * catches immediate lattice neighbours, so it has to be a multiple of it to thin results out.
 */
export function dedupe(candidates: Candidate[], radius: number): Candidate[] {
  const r2 = radius * radius
  const near = (p: AnchorOut, q: AnchorOut) => (p.e - q.e) ** 2 + (p.n - q.n) ** 2 <= r2
  const duplicates = (c: Candidate, k: Candidate) =>
    (near(c.a, k.a) && near(c.b, k.b)) || (near(c.a, k.b) && near(c.b, k.a))

  /**
   * Kept lines indexed by both of their endpoints, on a lattice of `radius`.
   *
   * A duplicate of `c` must have an endpoint within `radius` of `c.a` -- that is half of what the
   * test asks either way round -- so the nine cells around `c.a` hold every line worth comparing
   * against. Exact, not approximate.
   *
   * Scanning everything kept was fine at a few thousand candidates and quadratic beyond: a 141 km2
   * area produced 1.6 million feasible lines against 14,762 distinct ones, which is 24 billion
   * comparisons and most of an hour.
   */
  const cell = radius > 0 ? radius : 1
  const buckets = new Map<string, number[]>()
  const keyOf = (p: AnchorOut) => `${Math.floor(p.e / cell)}_${Math.floor(p.n / cell)}`
  const register = (index: number, p: AnchorOut) => {
    const key = keyOf(p)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(index)
    else buckets.set(key, [index])
  }

  const kept: Candidate[] = []
  for (const c of [...candidates].sort((x, y) => y.score - x.score)) {
    const cx = Math.floor(c.a.e / cell)
    const cy = Math.floor(c.a.n / cell)
    let duplicate = false
    for (let dx = -1; dx <= 1 && !duplicate; dx++) {
      for (let dy = -1; dy <= 1 && !duplicate; dy++) {
        for (const i of buckets.get(`${cx + dx}_${cy + dy}`) ?? []) {
          if (duplicates(c, kept[i]!)) {
            duplicate = true
            break
          }
        }
      }
    }
    if (duplicate) continue
    register(kept.length, c.a)
    register(kept.length, c.b)
    kept.push(c)
  }
  return kept
}

