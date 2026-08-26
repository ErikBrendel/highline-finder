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
 * What a line is, from its two anchors and nothing else.
 *
 * Anchors, not surroundings. A ground-to-ground line threading between two houses is still a
 * natural line, because what makes an urban line urban is having to get onto a building and be
 * allowed to rig off it -- a different approach, a different permission and different gear from
 * walking into a forest. Classifying by what happens to be nearby would put those two in the same
 * bucket and answer a question nobody asked.
 */
export function lineKind(aOnRoof: boolean, bOnRoof: boolean): LineKind {
  if (aOnRoof && bOnRoof) return 'urban'
  return aOnRoof || bOnRoof ? 'mixed' : 'natural'
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

export function sharedBits(w: number, h: number): Uint8Array {
  return new Uint8Array(new SharedArrayBuffer(Math.ceil((w * h) / 8)))
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
