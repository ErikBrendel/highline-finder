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
  segments: Iterable<[{ e: number; n: number }, { e: number; n: number }]>,
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
  const grid = Grid.shared(Math.ceil(w / res), Math.ceil(h / res), e0, n1, res)

  const tiles = tilesForBounds(bounds.minE, bounds.minN, bounds.maxE, bounds.maxN).filter(
    (t) => !only || only.has(t),
  )
  // Reduce whatever is not cached yet, several tiles at a time, then assemble from the cache.
  await ensureDownsampled(product, tiles, res)
  for (const tile of tiles) blitGrid(await loadTile(product, tile, res), grid)
  return grid
}

