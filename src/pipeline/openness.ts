import { Grid } from './raster.js'
import type { Params } from '../shared/types.js'

/**
 * Stage 2: find anchor candidates and record, per anchor, which directions are actually usable.
 *
 * Why this exists. The naive search is every pair of terrain cells, which for a 1 km^2 AOI at
 * 1 m is ~3.7e11 pairs -- not computable. This stage replaces it with a scan that is *linear*
 * in area: each point is examined on its own, and what gets stored is a bitmask of the angular
 * sectors in which a line could plausibly leave that point. Stage 3 then only pays for the
 * expensive full-profile test on pairs that are open *towards each other*.
 *
 * That asymmetry is the whole point architecturally: the linear stage is per-tile independent
 * and cacheable, so it parallelises across an arbitrarily large region, and the quadratic stage
 * is reduced to two array lookups per pair.
 *
 * The probe runs from the *highest* attachment the anchor allows (`ground + aFrameMax`), because
 * that is the most permissive case; a prefilter that rejected a direction the line could still
 * have used from a raised anchor would lose real candidates.
 *
 * A sector is open when both of these hold, evaluated by walking outward from the anchor:
 *
 *   (1) not blocked -- for all d in (anchorZone, blockProbeLength]:
 *           ground(d) <= anchorHeight + maxUpSlope * d - minClearance
 *   (2) drops away  -- min over d in (anchorZone, dropProbeLength] of ground(d)
 *                          <= anchorHeight - minProbeDrop
 *
 * (1) is a ray cast, not a slope test, and the difference is load-bearing. A 3 m berm 10 m in
 * front of the anchor blocks the line even though the terrain 50 m out plunges away; conversely
 * terrain may rise and still be fine as long as it stays under the line. Sag is ignored here
 * because sag only ever lowers the line, so ignoring it keeps the probe optimistic and
 * therefore safe as a prefilter.
 *
 * (2) is the "terrain has to fall off for a bit" requirement. Without it, flat ground is open in
 * all 64 directions -- correctly, since a flat line does clear flat ground -- and the prefilter
 * stops filtering. Those lines would all die later on minExposure anyway, but only after paying
 * for a profile scan each.
 *
 * Completeness. The prefilter is admissible for any line whose slope out of the anchor is at
 * most `maxUpSlope` and whose drop begins within `dropProbeLength`. Outside that envelope it can
 * produce false negatives: a line climbing steeper than 25% out of its anchor, or one crossing a
 * shelf longer than 120 m before the ground falls away, may be missed. Both bounds are params,
 * and run.ts logs how many pairs each stage eliminates so the trade can be checked against
 * evidence rather than assumed.
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
}

export function scanAnchors(
  ground: Grid,
  p: Params,
): { anchors: Anchor[]; scanned: number } {
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

  const minE = ground.e0
  const maxE = ground.e0 + ground.w * ground.res
  const minN = ground.n1 - ground.h * ground.res
  const maxN = ground.n1

  let scanned = 0
  for (let n = minN + p.anchorStep / 2; n < maxN; n += p.anchorStep) {
    for (let e = minE + p.anchorStep / 2; e < maxE; e += p.anchorStep) {
      const g = ground.nearest(e, n)
      if (Number.isNaN(g)) continue
      scanned++
      const anchorH = g + p.aFrameMax
      const open = new Uint8Array(sectorCount)
      let openCount = 0

      for (let s = 0; s < sectorCount; s++) {
        const de = sin[s]!
        const dn = cos[s]!
        let blocked = false
        let lowest = Infinity
        for (let d = p.anchorZone; d <= p.dropProbeLength; d += 1) {
          const gv = ground.sample(e + de * d, n + dn * d)
          if (Number.isNaN(gv)) break
          if (d <= p.blockProbeLength && gv > anchorH + p.maxUpSlope * d - p.minClearance) {
            blocked = true
            break
          }
          if (gv < lowest) lowest = gv
        }
        if (blocked) continue
        if (lowest > anchorH - p.minProbeDrop) continue
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
        })
      }
    }
  }
  return { anchors, scanned }
}
