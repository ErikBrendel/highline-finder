/**
 * The standing surface between the 1 m cells, defined once so that the figures and the 3D view
 * cannot disagree about it.
 *
 * Every cell has four corners of its own. A corner is the mean of the cells meeting there that are
 * within `WALL_M` of this cell -- so ground that runs on joins its neighbours smoothly, and a wall
 * or a roof step stays a vertical step on the cell boundary, never a ramp through it. Inside a
 * cell the surface is two flat triangles split along the south-east to north-west diagonal, which
 * is exactly what the 3D view draws (see `padMesh`).
 *
 * Cells are whole metres: cell (ci, cj) covers e in [ci, ci + 1) and n in [cj, cj + 1).
 */

import { crossings, intervals, type Seg } from './segments.js'

/** A rise between neighbouring cells steeper than 45 degrees, which no ground slopes at. */
export const WALL_M = 1

/** Height of cell (ci, cj), NaN where nothing was measured. */
export type CellReader = (ci: number, cj: number) => number

/** South-west, south-east, north-west, north-east. */
export type Corners = [number, number, number, number]

export function cornersOf(at: CellReader, ci: number, cj: number): Corners | null {
  const around: number[] = []
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) around.push(at(ci + di, cj + dj))
  const own = around[4]!
  if (Number.isNaN(own)) return null
  const corner = (di: 0 | 1, dj: 0 | 1) => {
    let sum = 0
    let count = 0
    for (const j of [dj, dj + 1]) {
      for (const i of [di, di + 1]) {
        const v = around[j * 3 + i]!
        if (Math.abs(v - own) > WALL_M || Number.isNaN(v)) continue
        sum += v
        count++
      }
    }
    return sum / count
  }
  return [corner(0, 0), corner(1, 0), corner(0, 1), corner(1, 1)]
}

/** The surface inside a cell, `u` east and `v` north from its south-west corner, both 0 to 1. */
export function within([sw, se, nw, ne]: Corners, u: number, v: number): number {
  return u + v <= 1
    ? sw + (se - sw) * u + (nw - sw) * v
    : ne + (nw - ne) * (1 - u) + (se - ne) * (1 - v)
}

export function surfaceAt(at: CellReader, e: number, n: number): number {
  const ci = Math.floor(e)
  const cj = Math.floor(n)
  const corners = cornersOf(at, ci, cj)
  return corners ? within(corners, e - ci, n - cj) : NaN
}

/**
 * The line from (e0, n0) to (e1, n1), between `from` and `to` of the way along, laid onto the
 * surface: a piece wherever it crosses a cell edge or a cell's diagonal, each on one flat triangle,
 * so the pieces are exact. Two cells meeting at a wall give two heights at the same place.
 */
export function drapeCells(
  at: CellReader, e0: number, n0: number, e1: number, n1: number, from = 0, to = 1,
): Seg[] {
  const cuts: number[] = []
  crossings(e0, e1, cuts)
  crossings(n0, n1, cuts)
  crossings(e0 + n0, e1 + n1, cuts)
  const out: Seg[] = []
  for (const [ta, tb] of intervals(cuts, from, to)) {
    const mid = (ta + tb) / 2
    const ci = Math.floor(e0 + (e1 - e0) * mid)
    const cj = Math.floor(n0 + (n1 - n0) * mid)
    const corners = cornersOf(at, ci, cj)
    if (!corners) continue
    const h = (t: number) =>
      within(
        corners,
        Math.min(1, Math.max(0, e0 + (e1 - e0) * t - ci)),
        Math.min(1, Math.max(0, n0 + (n1 - n0) * t - cj)),
      )
    out.push({ ta, tb, ya: h(ta), yb: h(tb) })
  }
  return out
}
