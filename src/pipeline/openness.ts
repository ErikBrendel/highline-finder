import { Grid, minFilter } from './raster.js'
import type { Params } from '../shared/types.js'

/**
 * Stage 2: find anchor candidates and record, per anchor, which directions are actually usable.
 *
 * Why this exists. The naive search is every pair of terrain cells, which for a 1 km^2 AOI at 1 m
 * is ~3.7e11 pairs -- not computable. This stage replaces it with a scan that is *linear* in area:
 * each point is examined on its own, and what gets stored is a bitmask of the angular sectors in
 * which a line could plausibly leave that point. Stage 3 then only pays for the expensive
 * full-profile test on pairs that are open *towards each other*.
 *
 * That asymmetry is the whole point architecturally: the linear stage is per-tile independent and
 * cacheable, so it parallelises across an arbitrarily large region, and the quadratic stage is
 * reduced to two array lookups per pair.
 *
 * Two tests, cheapest first.
 *
 *   A. Is there air anywhere near? The terrain must fall `minDropDepth` below the attachment point
 *      somewhere within `dropSearchRadius`. Every highline has air under it at some point, so a
 *      point with nothing deep enough nearby cannot produce one in any direction.
 *
 *      Two steps, because the cheap one is not exact: a lookup into a precomputed sliding-window
 *      minimum rejects most points outright, but that window is a square and so reaches
 *      `dropSearchRadius * sqrt(2)` into the corners. Whatever survives is confirmed against a true
 *      disc. Skipping the confirmation let 7 % of anchors through on a drop that was further away
 *      than the radius claims.
 *
 *   B. Does the ground fall away in this direction? Walking out from `anchorZone`, the terrain must
 *      stay below `anchorH - minFallSlope * d - minClearance` as far as `nearProbeLength`. A line
 *      leaves its anchor descending, so this is the envelope it needs; the walk aborts at the first
 *      violation, which is why most directions cost only a few samples.
 *
 * B is a ray cast, not a slope test, and the difference is load-bearing. A 3 m berm 10 m in front
 * of the anchor blocks the line even though the terrain 50 m out plunges away; conversely terrain
 * may undulate and still be fine as long as it stays under the envelope.
 *
 * Neither test is lossless, and the previous attempt to make one so is worth recording: the
 * strictly admissible form of A is `ground(d) <= anchorH + maxOffLevelRatio*d - minExposure`, and
 * at d = maxLength the offlevel term cancels minExposure exactly, leaving no constraint at all. A
 * provably lossless prefilter is therefore vacuous for long spans, so these are deliberate
 * trade-offs with the aggressiveness exposed as parameters, not derivations.
 *
 * Known losses: A requires *both* ends of a line to see the drop within `dropSearchRadius`, which
 * misses spans whose only air sits close to one anchor. B only looks at the near field, so it says
 * nothing about a line blocked further out -- that is left to the full profile test.
 *
 * Sectors are a bitmask rather than a single angular interval because openness is genuinely
 * multi-lobed: a spur ridge is open on two roughly opposing sides and blocked on the other two,
 * which no single interval can express without lying.
 */
export interface Anchor {
  e: number
  n: number
  ground: number
  /** Lowest and highest the line may attach, `ground + aFrameMin` .. `ground + aFrameMax`. */
  anchorMin: number
  anchorMax: number
  /** One byte per sector, 1 = open. Indexed by sectorOf(bearing). */
  open: Uint8Array
  /** Number of open sectors, kept for reporting. */
  openCount: number
  /** How far the terrain falls below the attachment point within `dropSearchRadius`. */
  dropDepth: number
}

export interface ScanResult {
  anchors: Anchor[]
  scanned: number
  /** Points that passed the omnidirectional drop test, before any direction was considered. */
  passedDropTest: number
}

/** Lowest terrain within a true disc of `radius`, or NaN if the disc holds no data. */
function lowestInDisc(ground: Grid, e: number, n: number, radius: number): number {
  const step = ground.res
  let lo = NaN
  for (let dn = -radius; dn <= radius; dn += step) {
    const across = Math.sqrt(Math.max(0, radius * radius - dn * dn))
    for (let de = -across; de <= across; de += step) {
      const g = ground.nearest(e + de, n + dn)
      if (g < lo || Number.isNaN(lo)) lo = g
    }
  }
  return lo
}

export function scanAnchors(ground: Grid, p: Params): ScanResult {
  const anchors: Anchor[] = []
  const { sectorCount } = p
  const sin = new Float64Array(sectorCount)
  const cos = new Float64Array(sectorCount)
  for (let s = 0; s < sectorCount; s++) {
    // Probe along the sector centre line. Bearing 0 = north, clockwise.
    const b = ((s + 0.5) / sectorCount) * 2 * Math.PI
    sin[s] = Math.sin(b)
    cos[s] = Math.cos(b)
  }

  const lowestNearby = minFilter(ground, p.dropSearchRadius)

  const minE = ground.e0
  const maxE = ground.e0 + ground.w * ground.res
  const minN = ground.n1 - ground.h * ground.res
  const maxN = ground.n1

  let scanned = 0
  let passedDropTest = 0
  for (let n = minN + p.anchorStep / 2; n < maxN; n += p.anchorStep) {
    for (let e = minE + p.anchorStep / 2; e < maxE; e += p.anchorStep) {
      const g = ground.nearest(e, n)
      if (Number.isNaN(g)) continue
      scanned++

      // Test A, measured from the highest attachment because that is the most permissive case.
      // The square window first, then the disc it is only an approximation of.
      const anchorH = g + p.aFrameMax
      const deepEnough = anchorH - p.minDropDepth
      if (!(lowestNearby.nearest(e, n) <= deepEnough)) continue
      const lowest = lowestInDisc(ground, e, n, p.dropSearchRadius)
      if (!(lowest <= deepEnough)) continue
      passedDropTest++

      const open = new Uint8Array(sectorCount)
      let openCount = 0
      for (let s = 0; s < sectorCount; s++) {
        const de = sin[s]!
        const dn = cos[s]!
        let ok = true
        for (let d = p.anchorZone; d <= p.nearProbeLength; d += 1) {
          const gv = ground.sample(e + de * d, n + dn * d)
          if (Number.isNaN(gv) || gv > anchorH - p.minFallSlope * d - p.minClearance) {
            ok = false
            break
          }
        }
        if (!ok) continue
        open[s] = 1
        openCount++
      }

      if (openCount > 0) {
        anchors.push({
          e,
          n,
          ground: g,
          anchorMin: g + p.aFrameMin,
          anchorMax: anchorH,
          open,
          openCount,
          dropDepth: anchorH - lowest,
        })
      }
    }
  }
  return { anchors, scanned, passedDropTest }
}

/**
 * Packs an anchor's open sectors into a compact hex string: one hex digit per four sectors, least
 * significant bit first within each digit.
 */
export function packSectors(open: Uint8Array): string {
  let out = ''
  for (let i = 0; i < open.length; i += 4) {
    let nibble = 0
    for (let b = 0; b < 4; b++) if (open[i + b]) nibble |= 1 << b
    out += nibble.toString(16)
  }
  return out
}
