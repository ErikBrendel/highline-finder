import { tilesForBounds } from '../shared/geo.js'
import { blitGrid, Grid } from '../shared/grid.js'
import { ensureDownsampled, loadTile } from './downsample.js'
import type { Product } from './cache.js'

/**
 * The 1 km tiles the corridors of these lines pass through, expanded by `margin`.
 *
 * Used to fetch the surface model for the ground a line actually crosses instead of for the whole
 * area of interest. A span is at most `maxLength`, so its bounding box covers at most two tiles per
 * axis and enumerating that box is both exact enough and trivially conservative. The margin covers
 * the refinement pass, which moves an anchor by up to `refineRadius` after this set is fixed --
 * without it a refined line could sample a tile that was never loaded, and an unloaded surface cell
 * reads as bare ground rather than as an error.
 */
export function corridorTiles(
  segments: [{ e: number; n: number }, { e: number; n: number }][],
  margin: number,
): Set<string> {
  const out = new Set<string>()
  for (const [a, b] of segments) {
    const e0 = Math.floor((Math.min(a.e, b.e) - margin) / 1000)
    const e1 = Math.floor((Math.max(a.e, b.e) + margin) / 1000)
    const n0 = Math.floor((Math.min(a.n, b.n) - margin) / 1000)
    const n1 = Math.floor((Math.max(a.n, b.n) + margin) / 1000)
    for (let e = e0; e <= e1; e++) for (let n = n0; n <= n1; n++) out.add(`33${e}-${n}`)
  }
  return out
}

/**
 * Assembles all tiles of one product covering the bounds into a single grid at `res`.
 *
 * `only` restricts which tiles are fetched. Cells left unfilled stay NaN, which the profile builder
 * treats as no canopy -- so the caller has to be sure the set covers everything it will sample.
 */
export async function loadProduct(
  product: Product,
  bounds: { minE: number; minN: number; maxE: number; maxN: number },
  res: number,
  only?: Set<string>,
): Promise<Grid> {
  const e0 = Math.floor(bounds.minE)
  const n1 = Math.ceil(bounds.maxN)
  const w = Math.ceil(bounds.maxE) - e0
  const h = n1 - Math.floor(bounds.minN)
  const grid = Grid.filled(Math.ceil(w / res), Math.ceil(h / res), e0, n1, res)

  const tiles = tilesForBounds(bounds.minE, bounds.minN, bounds.maxE, bounds.maxN).filter(
    (t) => !only || only.has(t),
  )
  // Reduce whatever is not cached yet, several tiles at a time, then assemble from the cache.
  await ensureDownsampled(product, tiles, res)
  for (const tile of tiles) blitGrid(await loadTile(product, tile, res), grid)
  return grid
}

/**
 * Lowest terrain within `radius` of every cell, as a new grid.
 *
 * Precomputing this turns "is there anything deep enough near this point" from a scan of a few
 * thousand cells into one lookup, which is what makes the omnidirectional anchor prefilter cheap
 * enough to run before the directional scan rather than after it.
 *
 * Separable: a horizontal pass then a vertical one, which is exact for a square window and close
 * enough to a disc for a prefilter. The window scan is naive rather than a monotonic deque -- at
 * radius 25 that is ~90M comparisons for a square kilometre, well under a second, and the deque
 * version only starts to matter if the radius grows a lot.
 */
export function minFilter(src: Grid, radius: number): Grid {
  const r = Math.max(0, Math.round(radius / src.res))
  const { w, h } = src
  const mid = new Float32Array(w * h)
  const out = new Float32Array(w * h)

  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      let m = NaN
      for (let k = Math.max(0, x - r), end = Math.min(w - 1, x + r); k <= end; k++) {
        const v = src.data[row + k]!
        if (v < m || Number.isNaN(m)) m = v
      }
      mid[row + x] = m
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = NaN
      for (let k = Math.max(0, y - r), end = Math.min(h - 1, y + r); k <= end; k++) {
        const v = mid[k * w + x]!
        if (v < m || Number.isNaN(m)) m = v
      }
      out[y * w + x] = m
    }
  }
  return new Grid(out, w, h, src.e0, src.n1, src.res)
}
