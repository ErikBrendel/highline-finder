import { readFile } from 'node:fs/promises'
import { tilesForBounds } from '../shared/geo.js'
import { Grid } from '../shared/grid.js'
import { blitGeoTiff } from '../shared/geotiff.js'
import { tileTiff, type Product } from './cache.js'

/** Assembles all tiles of one product covering the bounds into a single grid at `res`. */
export async function loadProduct(
  product: Product,
  bounds: { minE: number; minN: number; maxE: number; maxN: number },
  res: number,
): Promise<Grid> {
  const e0 = Math.floor(bounds.minE)
  const n1 = Math.ceil(bounds.maxN)
  const w = Math.ceil(bounds.maxE) - e0
  const h = n1 - Math.floor(bounds.minN)
  const grid = Grid.filled(Math.ceil(w / res), Math.ceil(h / res), e0, n1, res)

  for (const tile of tilesForBounds(bounds.minE, bounds.minN, bounds.maxE, bounds.maxN)) {
    const buf = await readFile(await tileTiff(product, tile))
    await blitGeoTiff(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
      grid,
    )
  }
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
