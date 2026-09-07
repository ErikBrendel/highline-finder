import type { CellGeometry, Grid } from './grid.js'
import type { LineKind, Params } from './types.js'

/**
 * What each end of a line is attached to, and what follows from it.
 *
 * The ground the search stands on is terrain merged with roofs -- see lod1.ts -- and once merged
 * the two are indistinguishable. Two rules need them told apart, so both live here rather than
 * being re-derived at every site: how high the line may attach, and what kind of line the pair
 * makes. Both the pipeline and the browser planner go through these, so a hand-placed line and a
 * found one are classified and rigged by the same rule.
 */

/** Whether a building stands at a point. Null anywhere a caller has no city model. */
export interface Roofs {
  covers(e: number, n: number): boolean
}

/**
 * Where a line may attach at one end, as a range above whatever the point stands on.
 *
 * On open ground that is the A-frame range: a clean edge can be rigged at ground level and a
 * rounded one needs a frame, and that slack is the only freedom the search has to level a line out.
 *
 * On a roof there is none. An A-frame on a rooftop is not what gets rigged -- the line goes on a
 * parapet, a ring anchor or the structure itself, all of which sit at roof level -- so a roof
 * anchor attaches exactly where the roof is, and a pair of roofs at unequal heights has to be
 * level enough on its own. That costs short roof-to-roof lines specifically: at 50 m the entire
 * offlevel budget is 1.5 m, which is exactly what the frame used to supply.
 */
export function rigRange(onRoof: boolean, p: Params): { min: number; max: number } {
  return onRoof ? { min: 0, max: 0 } : { min: p.aFrameMin, max: p.aFrameMax }
}

/**
 * What is standing where an anchor is placed, measured from the ground it stands on.
 *
 * Heights above the *composite* ground -- terrain, or the roof where there is a building -- which is
 * the same datum `aFrame` has always used. Bare earth would be needed to describe an anchor part way
 * up a wall, out of a window; nothing else here needs it, so nothing else here asks for it.
 */
export interface Standing {
  onRoof: boolean
  /** How far vegetation reaches above that ground. Zero where there is none, or none is known. */
  canopy: number
}

/**
 * How high up a tree it is worth calling a trunk.
 *
 * Half the canopy, and the number is a judgement rather than a measurement: what the surface model
 * gives is the height of the crown, and the usable trunk is somewhere below where it thins out.
 * Half is the optimistic end of what people actually rig -- this is advice to someone standing in
 * front of the tree, who can see what the survey cannot, so it errs towards letting them decide.
 * A search would want a third. See ROADMAP: trunk detection from the classified point cloud is what
 * would replace the guess.
 */
export const TRUNK_FRACTION = 0.5

/**
 * What you would have to bring to rig at this height. Every height is reachable by something.
 *
 * The old question was whether a height was allowed, and the answer was a violation. That is the
 * wrong shape: a line rigged twelve metres up a pine is not an invalid line, it is a line that costs
 * a climb -- and one on a mast is not invalid either, it is one that costs a crane. So the height is
 * always accepted and what varies is the means, which is what the panel names and what `rigCost`
 * charges for.
 */
export type RigMeans = 'edge' | 'aFrame' | 'trunk' | 'crown' | 'brought'

export function rigMeans(height: number, s: Standing, p: Params): RigMeans {
  const free = rigRange(s.onRoof, p).max
  if (height <= p.aFrameMin) return 'edge'
  if (height <= free) return 'aFrame'
  if (height <= TRUNK_FRACTION * s.canopy) return 'trunk'
  if (height <= s.canopy) return 'crown'
  return 'brought'
}

/**
 * What rigging that high costs the score, in bands rather than tiers.
 *
 * Banded because a tier would be a step, and a step is a cliff for the optimiser to fall off: two
 * anchors a centimetre apart would score points apart, and the hill-climb would chase the boundary
 * instead of the line. Each metre is charged at the rate of the band it falls in, so the total is
 * continuous and rises monotonically, and a rig that stays inside what a carried A-frame reaches is
 * free exactly as before.
 *
 * The rates say what the means costs to arrange, which is what the score is being asked to reflect.
 * Climbing a trunk is cheap and is what people here actually do; the thin top of a crown is dearer
 * and less certain; anything above what is standing there has to be carried in and put up.
 */
export function rigCost(height: number, s: Standing, p: Params): number {
  const free = rigRange(s.onRoof, p).max
  const trunk = Math.max(free, TRUNK_FRACTION * s.canopy)
  const crown = Math.max(trunk, s.canopy)
  const band = (from: number, to: number, rate: number) =>
    Math.max(0, Math.min(height, to) - from) * rate
  return (
    band(free, trunk, RIG_RATE.trunk) +
    band(trunk, crown, RIG_RATE.crown) +
    band(crown, Infinity, RIG_RATE.brought)
  )
}

/** Score points per metre, by the band the metre falls in. See `rigCost`. */
export const RIG_RATE = { trunk: 0.4, crown: 2, brought: 6 } as const

/**
 * What a line is, from its two anchors and nothing else.
 *
 * Anchors, not surroundings. A ground-to-ground line threading between two houses is still a
 * natural line, because what makes an urban line urban is having to get onto a building and be
 * allowed to rig off it -- a different approach, a different permission and different gear from
 * walking into a forest. Classifying by what happens to be nearby would put those two in the same
 * bucket and answer a question nobody asked.
 *
 * One roof is enough for that, which is why there is no third class between them: a line with a
 * roof at one end still needs the owner, the access and the permission, and having the far end on
 * open ground buys none of it back.
 */
export function lineKind(aOnRoof: boolean, bOnRoof: boolean): LineKind {
  return aOnRoof || bOnRoof ? 'urban' : 'natural'
}

/**
 * Which cells of a region a building covers, one bit each.
 *
 * A bit rather than the roof heights, because the heights are already in the ground grid -- all
 * this has to answer afterwards is whether that height is a roof or a hill. At 1 m over the 200 km2
 * Eberswalde region a float copy would be 800 MB and this is 25.
 */
/** One bit per cell, on shared memory so the worker threads read the same bits. */
export interface MaskShare extends CellGeometry {
  buffer: SharedArrayBuffer
}

/** See Grid.shared for why this is asked for explicitly rather than being the default. */
export function sharedBits(w: number, h: number): Uint8Array {
  return new Uint8Array(new SharedArrayBuffer(Math.ceil((w * h) / 8)))
}

export function plainBits(w: number, h: number): Uint8Array {
  return new Uint8Array(Math.ceil((w * h) / 8))
}

export class RoofMask implements Roofs {
  private constructor(
    private readonly bits: Uint8Array,
    private readonly w: number,
    private readonly h: number,
    private readonly e0: number,
    private readonly n1: number,
    private readonly res: number,
  ) {}

  static forGrid(g: Grid): RoofMask {
    return new RoofMask(plainBits(g.w, g.h), g.w, g.h, g.e0, g.n1, g.res)
  }

  /** Readable from the worker pool. See Grid.shared for why this is not the default. */
  static sharedFor(g: Grid): RoofMask {
    return new RoofMask(sharedBits(g.w, g.h), g.w, g.h, g.e0, g.n1, g.res)
  }

  share(): MaskShare {
    const { w, h, e0, n1, res } = this
    return { buffer: this.bits.buffer as SharedArrayBuffer, w, h, e0, n1, res }
  }

  static adopt(v: MaskShare): RoofMask {
    return new RoofMask(new Uint8Array(v.buffer), v.w, v.h, v.e0, v.n1, v.res)
  }

  private indexAt(e: number, n: number): number {
    const col = Math.floor((e - this.e0) / this.res)
    const row = Math.floor((this.n1 - n) / this.res)
    if (col < 0 || row < 0 || col >= this.w || row >= this.h) return -1
    return row * this.w + col
  }

  /**
   * Marks every cell `src` holds a height in, dropping whatever falls outside -- the same rule
   * blitGrid applies to the heights themselves, so mask and grid always agree on which cells a
   * building reached.
   */
  add(src: Grid): void {
    for (let row = 0; row < src.h; row++) {
      const n = src.n1 - (row + 0.5) * src.res
      for (let col = 0; col < src.w; col++) {
        if (Number.isNaN(src.data[row * src.w + col]!)) continue
        const i = this.indexAt(src.e0 + (col + 0.5) * src.res, n)
        if (i >= 0) this.bits[i >> 3]! |= 1 << (i & 7)
      }
    }
  }

  covers(e: number, n: number): boolean {
    const i = this.indexAt(e, n)
    return i >= 0 && (this.bits[i >> 3]! & (1 << (i & 7))) !== 0
  }

  /** Cells marked, for reporting how much roof a region gained. */
  count(): number {
    let n = 0
    for (const byte of this.bits) {
      for (let b = byte; b; b >>= 1) n += b & 1
    }
    return n
  }
}
