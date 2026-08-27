import { Grid, minFilter } from '../shared/grid.js'
import { phaseAt, phaseDone } from '../shared/phases.js'
import { rigRange, type Roofs } from '../shared/anchoring.js'
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
  /** Lowest and highest the line may attach. See rigRange: a roof anchor has no range at all. */
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
  /** Points on a roof outside any urban area, which is ground nobody looked at. */
  skippedRoof: number
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

/**
 * `ground` is terrain with roofs merged in, so `roofs` is what tells the two apart -- and the
 * difference is not cosmetic here: a roof anchor gets no A-frame, which lowers its attachment point
 * and therefore tightens both the drop test and the fall-away envelope below. Null means no city
 * model, so everything counts as open ground.
 */
/**
 * The first lattice point at or after `edge`, on a lattice fixed to the projection.
 *
 * Fixed to EPSG:25833 rather than to the region's own corner, so that where the search looks does
 * not depend on where the region happens to start. Laying the lattice out from `ground.e0` meant
 * that widening an area of interest moved every anchor in it: growing Eberswalde west by 5,738 m
 * shifted the whole lattice by 3 m, which changed 720 lines in the *east* -- ground the expansion
 * never touched -- and jittered the score of nearly every line that survived. Different anchors
 * give different candidates, different dedup winners and different refinement starts, so none of
 * that churn was the search finding better answers.
 *
 * Cells are sampled at their centres, so the lattice is offset by half a step: on a 5 m step the
 * points sit at 2.5, 7.5, 12.5 and so on, whatever region is being searched.
 */
function latticeFrom(edge: number, step: number): number {
  const half = step / 2
  return Math.ceil((edge - half) / step) * step + half
}

export function scanAnchors(
  ground: Grid,
  p: Params,
  roofs: Roofs | null = null,
  /**
   * Where a roof may be stood on. Null means anywhere, which is what every caller but the pipeline
   * wants; the pipeline passes the urban areas, and a point on a roof outside them is skipped
   * rather than searched -- there is no anchor under a building.
   */
  urban: Roofs | null = null,
): ScanResult {
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

  // Over the whole grid, not over the scanned points -- so this cost is set by the area and does
  // not fall when anchorStep rises. Timed because that makes it the part of the scan that no
  // coarsening of the lattice can reach.
  const tFilter = phaseAt()
  const lowestNearby = minFilter(ground, p.dropSearchRadius)
  phaseDone('min filter over the whole grid', tFilter)

  const maxE = ground.e0 + ground.w * ground.res
  const maxN = ground.n1
  const firstE = latticeFrom(ground.e0, p.anchorStep)
  const firstN = latticeFrom(ground.n1 - ground.h * ground.res, p.anchorStep)

  let scanned = 0
  let skippedRoof = 0
  let passedDropTest = 0
  for (let n = firstN; n < maxN; n += p.anchorStep) {
    for (let e = firstE; e < maxE; e += p.anchorStep) {
      const g = ground.nearest(e, n)
      if (Number.isNaN(g)) continue
      scanned++

      const onRoof = roofs?.covers(e, n) ?? false
      if (onRoof && urban && !urban.covers(e, n)) {
        skippedRoof++
        continue
      }

      // Test A, measured from the highest attachment because that is the most permissive case.
      const tDrop = phaseAt()
      const range = rigRange(onRoof, p)
      const anchorH = g + range.max
      const deepEnough = anchorH - p.minDropDepth
      // The square window first, then the disc it is only an approximation of.
      const lowest =
        lowestNearby.nearest(e, n) <= deepEnough
          ? lowestInDisc(ground, e, n, p.dropSearchRadius)
          : Infinity
      phaseDone('drop test per scanned point', tDrop)
      if (!(lowest <= deepEnough)) continue
      passedDropTest++

      const tSectors = phaseAt()
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
      phaseDone('sector probes per surviving point', tSectors)

      if (openCount > 0) {
        anchors.push({
          e,
          n,
          ground: g,
          anchorMin: g + range.min,
          anchorMax: anchorH,
          open,
          openCount,
          dropDepth: anchorH - lowest,
        })
      }
    }
  }
  return { anchors, scanned, skippedRoof, passedDropTest }
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

/**
 * The anchors as flat numbers rather than objects.
 *
 * The pair search is a numeric kernel: it walks a billion candidate pairs on the biggest region and
 * touches nothing about an anchor but its coordinates, its attachment range and its open sectors.
 * Reading those out of three hundred thousand scattered objects is a cache miss per pair, and
 * measured on that shape the same loop runs nine times faster over typed arrays.
 *
 * Only the four fields that loop reads are here. Ground height and drop depth stay on the `Anchor`,
 * where the debug dump reads them once -- putting them in the table would cost a third more memory
 * and, worse, push the four that are read apart in the cache line. Sharing the table with the
 * worker threads costs nothing extra: it is already the layout a SharedArrayBuffer wants.
 */
export interface AnchorTable {
  /** `ANCHOR_FIELDS` doubles per anchor, laid out by the `AT_*` offsets below. */
  fields: SharedArrayBuffer
  /** `sectorCount` bytes per anchor, one per sector. */
  open: SharedArrayBuffer
  count: number
  sectorCount: number
}

export const ANCHOR_FIELDS = 4
export const AT_E = 0
export const AT_N = 1
export const AT_MIN = 2
export const AT_MAX = 3

export function packAnchors(anchors: Anchor[], sectorCount: number): AnchorTable {
  const fields = new Float64Array(new SharedArrayBuffer(anchors.length * ANCHOR_FIELDS * 8))
  const open = new Uint8Array(new SharedArrayBuffer(anchors.length * sectorCount))
  anchors.forEach((a, i) => {
    const at = i * ANCHOR_FIELDS
    fields[at + AT_E] = a.e
    fields[at + AT_N] = a.n
    fields[at + AT_MIN] = a.anchorMin
    fields[at + AT_MAX] = a.anchorMax
    open.set(a.open, i * sectorCount)
  })
  return {
    fields: fields.buffer as SharedArrayBuffer,
    open: open.buffer as SharedArrayBuffer,
    count: anchors.length,
    sectorCount,
  }
}
