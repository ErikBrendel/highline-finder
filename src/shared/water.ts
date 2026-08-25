import { fillPolygon, type CellGeometry } from './grid.js'
import type { Water } from './osmBlocks.js'
import type { Params } from './types.js'

/**
 * Where there is water under the line, and what that changes.
 *
 * A line three metres over a field and a line three metres over a lake are not the same proposition.
 * Falling into water is the ordinary way a highline session ends; falling onto ground is how one
 * ends badly. So water asks for less air than solid ground does -- see `Params.waterClearance` --
 * and this is the layer that says which is which.
 *
 * Islands are the reason this is not simply "inside a lake outline". A wooded island in the middle
 * of a Brandenburg lake is solid ground with trees on it, and a rule that reads the lake as water
 * all the way across would offer a line one metre of clearance over exactly the thing it must not
 * hit. OSM names its inner rings, so the distinction is carried rather than inferred -- ring
 * orientation is not reliably maintained and would have been the wrong thing to trust.
 */

/** Whatever can answer "is this point over water". */
export interface WaterCover {
  covers(e: number, n: number): boolean
}

/**
 * Clearance owed at one point: the base every line owes, or the smaller figure over water.
 *
 * The whole rule in one place, so the search, the planner and the profile chart cannot disagree
 * about what a sample is being held to.
 */
export const clearanceNeeded = (overWater: boolean, p: Params): number =>
  overWater ? p.waterClearance : p.minClearance

/**
 * Water as a bit per cell, rasterised once and then read in constant time.
 *
 * A point-in-polygon test against the outlines themselves is the obvious implementation and is far
 * too slow to sit where this sits: the search measures two million profiles per region, each of a
 * hundred and twenty samples, each of those across a band. That is hundreds of millions of lookups,
 * and a bit per cell answers each of them with one shift.
 *
 * Rings first and islands after, in that order and not interleaved, because an island's lake may
 * have been drawn by a different ring: clearing as we go would let a later ring fill an island back
 * in.
 */
export class WaterMask implements WaterCover {
  private readonly bits: Uint8Array

  constructor(private readonly geom: CellGeometry) {
    this.bits = new Uint8Array(Math.ceil((geom.w * geom.h) / 8))
  }

  add(water: Water): void {
    for (const ring of water.rings) {
      fillPolygon(ring, this.geom, (i) => {
        this.bits[i >> 3]! |= 1 << (i & 7)
      })
    }
    for (const island of water.islands) {
      fillPolygon(island, this.geom, (i) => {
        this.bits[i >> 3]! &= ~(1 << (i & 7))
      })
    }
  }

  covers(e: number, n: number): boolean {
    const { w, h, e0, n1, res } = this.geom
    const col = Math.floor((e - e0) / res)
    const row = Math.floor((n1 - n) / res)
    if (col < 0 || row < 0 || col >= w || row >= h) return false
    const i = row * w + col
    return (this.bits[i >> 3]! & (1 << (i & 7))) !== 0
  }

  /** Cells marked, for reporting how much water a region carries. */
  get cells(): number {
    let count = 0
    for (const byte of this.bits) {
      for (let bit = 0; bit < 8; bit++) if (byte & (1 << bit)) count++
    }
    return count
  }
}
