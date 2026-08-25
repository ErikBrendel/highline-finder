/**
 * Anything that can report a height at a projected coordinate.
 *
 * The search samples a single mosaicked Grid; the interactive planner samples a set of WCS windows
 * that arrive one at a time. Depending on this rather than on Grid is what lets both use the same
 * profile and scoring code.
 */
export interface Sampler {
  sample(e: number, n: number): number
  /**
   * The containing cell's own value, without interpolation.
   *
   * Used where the question is "is there anything here", not "how high is the ground at this
   * point". Interpolating averages a thin wall with the ground beside it and reports neither, which
   * is the wrong answer for an obstruction scan -- and four lookups instead of one for the
   * privilege. See worstAcross in profile.ts.
   */
  nearest(e: number, n: number): number
}

/** A point in EPSG:25833. */
export interface Pos {
  e: number
  n: number
}

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

/**
 * Copies `src` into `dest`, keeping the greater value where they overlap.
 *
 * Same rule as the GeoTIFF blitter, for the same reason: the tallest obstacle in a cell is the one
 * that matters for clearance. Cells of `src` that fall outside `dest` are dropped.
 */
export function blitGrid(src: Grid, dest: Grid): void {
  for (let sy = 0; sy < src.h; sy++) {
    const n = src.n1 - (sy + 0.5) * src.res
    const drow = Math.floor((dest.n1 - n) / dest.res)
    if (drow < 0 || drow >= dest.h) continue
    for (let sx = 0; sx < src.w; sx++) {
      const v = src.data[sy * src.w + sx]!
      if (Number.isNaN(v)) continue
      const e = src.e0 + (sx + 0.5) * src.res
      const dcol = Math.floor((e - dest.e0) / dest.res)
      if (dcol < 0 || dcol >= dest.w) continue
      const i = drow * dest.w + dcol
      const cur = dest.data[i]!
      if (Number.isNaN(cur) || v > cur) dest.data[i] = v
    }
  }
}
