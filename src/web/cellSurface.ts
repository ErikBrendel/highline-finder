/**
 * The standing surface between the 1 m cells, defined once so that the figures and the 3D view
 * cannot disagree about it.
 *
 * Each cell's height sits at its centre, and between four centres the surface is two flat
 * triangles split along the south-east to north-west diagonal -- exactly what the 3D view draws
 * around an anchor (see `padMesh`). Continuous, so a wall is a ramp one cell wide: an anchor within
 * half a metre of one stands partway up it, in the figures and in the picture alike.
 *
 * Cells are whole metres: cell (ci, cj) covers e in [ci, ci + 1) and n in [cj, cj + 1).
 */

import { crossings, intervals, type Seg } from './segments.js'

/** Height of cell (ci, cj), NaN where nothing was measured. */
export type CellReader = (ci: number, cj: number) => number

/**
 * The surface at a point `u` east and `v` north of the centre of cell (i, j), both 0 to 1, or the
 * nearest cell's own height where one of the four centres around it was never measured.
 */
function between(at: CellReader, i: number, j: number, u: number, v: number): number {
  const [sw, se, nw, ne] = [at(i, j), at(i + 1, j), at(i, j + 1), at(i + 1, j + 1)]
  if (Number.isNaN(sw + se + nw + ne)) return at(i + (u < 0.5 ? 0 : 1), j + (v < 0.5 ? 0 : 1))
  return u + v <= 1
    ? sw + (se - sw) * u + (nw - sw) * v
    : ne + (nw - ne) * (1 - u) + (se - ne) * (1 - v)
}

export function surfaceAt(at: CellReader, e: number, n: number): number {
  const i = Math.floor(e - 0.5)
  const j = Math.floor(n - 0.5)
  return between(at, i, j, e - 0.5 - i, n - 0.5 - j)
}

/**
 * The line from (e0, n0) to (e1, n1), between `from` and `to` of the way along, laid onto the
 * surface: a piece wherever it crosses a line between cell centres or a diagonal, each on one flat
 * triangle, so the pieces are exact.
 */
export function drapeCells(
  at: CellReader, e0: number, n0: number, e1: number, n1: number, from = 0, to = 1,
): Seg[] {
  const [x0, y0, x1, y1] = [e0 - 0.5, n0 - 0.5, e1 - 0.5, n1 - 0.5]
  const cuts: number[] = []
  crossings(x0, x1, cuts)
  crossings(y0, y1, cuts)
  crossings(x0 + y0, x1 + y1, cuts)
  const out: Seg[] = []
  for (const [ta, tb] of intervals(cuts, from, to)) {
    const mid = (ta + tb) / 2
    const i = Math.floor(x0 + (x1 - x0) * mid)
    const j = Math.floor(y0 + (y1 - y0) * mid)
    const h = (t: number) =>
      between(
        at, i, j,
        Math.min(1, Math.max(0, x0 + (x1 - x0) * t - i)),
        Math.min(1, Math.max(0, y0 + (y1 - y0) * t - j)),
      )
    const [ya, yb] = [h(ta), h(tb)]
    if (!Number.isNaN(ya + yb)) out.push({ ta, tb, ya, yb })
  }
  return out
}
