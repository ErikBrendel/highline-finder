import { readFile } from 'node:fs/promises'
import { fromArrayBuffer } from 'geotiff'
import { tilesForBounds } from '../shared/geo.js'
import { tileTiff, type Product } from './cache.js'

/**
 * Minimal float raster in EPSG:25833, north-up, square cells.
 *
 * The source GeoTIFFs are single-band float32, LZW compressed, nodata -9999, with a pixel-is-area
 * model: ModelTiepoint gives the top-left *corner*, so cell (col,row) is centred half a cell in.
 * nodata becomes NaN on read so it propagates instead of poisoning arithmetic with -9999.
 */
export class Grid {
  constructor(
    readonly data: Float32Array,
    readonly w: number,
    readonly h: number,
    /** Easting of the left edge. */
    readonly e0: number,
    /** Northing of the top edge. */
    readonly n1: number,
    readonly res: number,
  ) {}

  static filled(w: number, h: number, e0: number, n1: number, res: number): Grid {
    return new Grid(new Float32Array(w * h).fill(NaN), w, h, e0, n1, res)
  }

  at(col: number, row: number): number {
    if (col < 0 || row < 0 || col >= this.w || row >= this.h) return NaN
    return this.data[row * this.w + col]!
  }

  /** Nearest-cell lookup by projected coordinate. */
  nearest(e: number, n: number): number {
    return this.at(Math.floor((e - this.e0) / this.res), Math.floor((this.n1 - n) / this.res))
  }

  /**
   * Bilinear lookup by projected coordinate, falling back to nearest when any contributing
   * cell is nodata. Used for line profiles, where interpolation makes the 1 m terrain read as
   * a smooth section rather than a staircase.
   */
  sample(e: number, n: number): number {
    const fx = (e - this.e0) / this.res - 0.5
    const fy = (this.n1 - n) / this.res - 0.5
    const x0 = Math.floor(fx)
    const y0 = Math.floor(fy)
    const tx = fx - x0
    const ty = fy - y0
    const v00 = this.at(x0, y0)
    const v10 = this.at(x0 + 1, y0)
    const v01 = this.at(x0, y0 + 1)
    const v11 = this.at(x0 + 1, y0 + 1)
    if (Number.isNaN(v00 + v10 + v01 + v11)) return this.nearest(e, n)
    return (
      v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty
    )
  }

  extent(): { min: number; max: number; valid: number } {
    let min = Infinity
    let max = -Infinity
    let valid = 0
    for (const v of this.data) {
      if (Number.isNaN(v)) continue
      valid++
      if (v < min) min = v
      if (v > max) max = v
    }
    return { min, max, valid }
  }
}

const NODATA = -9999

/**
 * Reads one tile and blits it into `dest`, aggregating with max when the tile is finer than the
 * destination. Max (not mean) is deliberate for the surface model: for clearance testing the
 * tallest obstacle inside a cell is the one that matters, and averaging a treetop with the gap
 * beside it invents clearance that is not there.
 *
 * Read happens in horizontal strips so a 5000x5000 float32 tile never materialises whole
 * (100 MB each); this is also what makes a whole-Brandenburg run conceivable later.
 */
async function blitTile(path: string, dest: Grid): Promise<void> {
  const buf = await readFile(path)
  const tiff = await fromArrayBuffer(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
  )
  const img = await tiff.getImage()
  const [ox, oy] = img.getOrigin()
  const [rx] = img.getResolution()
  const srcRes = Math.abs(rx)
  const w = img.getWidth()
  const h = img.getHeight()

  const stripRows = Math.max(1, Math.floor(2e6 / w))
  for (let top = 0; top < h; top += stripRows) {
    const bottom = Math.min(h, top + stripRows)
    const [band] = (await img.readRasters({ window: [0, top, w, bottom] })) as unknown as Float32Array[]
    for (let sy = top; sy < bottom; sy++) {
      const n = oy - (sy + 0.5) * srcRes
      const drow = Math.floor((dest.n1 - n) / dest.res)
      if (drow < 0 || drow >= dest.h) continue
      const rowOff = (sy - top) * w
      for (let sx = 0; sx < w; sx++) {
        const v = band![rowOff + sx]!
        if (v <= NODATA + 1) continue
        const e = ox + (sx + 0.5) * srcRes
        const dcol = Math.floor((e - dest.e0) / dest.res)
        if (dcol < 0 || dcol >= dest.w) continue
        const i = drow * dest.w + dcol
        const cur = dest.data[i]!
        if (Number.isNaN(cur) || v > cur) dest.data[i] = v
      }
    }
  }
}

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
    await blitTile(await tileTiff(product, tile), grid)
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
