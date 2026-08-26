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

/**
 * Enough of a raster's layout to say which cell a coordinate is in. Grid satisfies it, and so does
 * anything else laid out the same way -- a bitmask, for one.
 */
export interface CellGeometry {
  w: number
  h: number
  /** Easting of the left edge. */
  e0: number
  /** Northing of the top edge. */
  n1: number
  res: number
}

/**
 * Visits every cell whose centre falls inside a closed ring, given as flat `[e, n, ...]`.
 *
 * Even-odd scanline: for each row, find where the ring crosses that row's centre line, sort the
 * crossings, and fill between them in pairs. Cells outside the raster are clipped rather than
 * wrapped, so a ring hanging over the edge fills the part that is there.
 *
 * Shared because there are two rasters made of polygons -- building footprints and water outlines
 * -- and having them disagree about which cells a polygon covers would be a bug nobody would think
 * to look for.
 */
export function fillPolygon(
  ring: number[],
  g: CellGeometry,
  visit: (index: number, col: number, row: number) => void,
): void {
  let minN = Infinity
  let maxN = -Infinity
  for (let i = 1; i < ring.length; i += 2) {
    if (ring[i]! < minN) minN = ring[i]!
    if (ring[i]! > maxN) maxN = ring[i]!
  }
  const rowOf = (n: number) => (g.n1 - n) / g.res - 0.5
  const row0 = Math.max(0, Math.ceil(rowOf(maxN)))
  const row1 = Math.min(g.h - 1, Math.floor(rowOf(minN)))

  const crossings: number[] = []
  for (let row = row0; row <= row1; row++) {
    const n = g.n1 - (row + 0.5) * g.res
    crossings.length = 0
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      const ay = ring[i + 1]!
      const by = ring[j + 1]!
      if (ay > n === by > n) continue
      crossings.push(ring[i]! + ((n - ay) / (by - ay)) * (ring[j]! - ring[i]!))
    }
    crossings.sort((a, b) => a - b)
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const colOf = (e: number) => (e - g.e0) / g.res - 0.5
      const col0 = Math.max(0, Math.ceil(colOf(crossings[k]!)))
      const col1 = Math.min(g.w - 1, Math.floor(colOf(crossings[k + 1]!)))
      for (let col = col0; col <= col1; col++) visit(row * g.w + col, col, row)
    }
  }
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
export interface GridShare extends CellGeometry {
  buffer: SharedArrayBuffer
}

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

  /**
   * A grid the worker threads can read without a copy.
   *
   * Backed by a SharedArrayBuffer rather than the usual one, because the terrain and surface
   * rasters are 700 MB each on the biggest region and handing every worker its own would run the
   * machine out of memory long before it ran out of cores. Nothing writes to a grid after it is
   * assembled, so sharing needs no synchronisation beyond the message that says it is ready.
   */
  static filled(w: number, h: number, e0: number, n1: number, res: number): Grid {
    // Floored, because a typed-array length is, and a fixture built from metres over a cell size
    // does not always divide.
    const data = new Float32Array(new SharedArrayBuffer(Math.floor(w * h) * 4))
    return new Grid(data.fill(NaN), w, h, e0, n1, res)
  }

  /** Everything a worker needs to read this grid, and nothing that would have to be copied. */
  share(): GridShare {
    return { buffer: this.data.buffer as SharedArrayBuffer, w: this.w, h: this.h, e0: this.e0, n1: this.n1, res: this.res }
  }

  static adopt(v: GridShare): Grid {
    return new Grid(new Float32Array(v.buffer), v.w, v.h, v.e0, v.n1, v.res)
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
 * Sliding-window minimum along one axis, in one pass, using a monotonic deque.
 *
 * The deque holds the indices of the only values that can still win: anything with a smaller value
 * to its right is already beaten for every remaining window, so it is dropped on the way in. Each
 * index is pushed once and popped once, which makes the cost per cell a constant independent of the
 * window -- against the naive scan's one comparison per cell of the window.
 *
 * Written once and used for both axes: `step` walks the axis being filtered and `lineStep` walks
 * between lines, so a horizontal pass is (1, w) and a vertical pass is (w, 1).
 */
function slidingMin(
  read: Float32Array,
  write: Float32Array,
  lines: number,
  len: number,
  lineStep: number,
  step: number,
  r: number,
  dq: Int32Array,
): void {
  for (let line = 0; line < lines; line++) {
    const base = line * lineStep
    let head = 0
    let tail = 0
    const push = (i: number) => {
      const v = read[base + i * step]!
      while (tail > head && read[base + dq[tail - 1]! * step]! >= v) tail--
      dq[tail++] = i
    }
    // Everything the first output can see; from then on one index enters and one leaves per cell.
    for (let i = 0, last = Math.min(r, len - 1); i <= last; i++) push(i)
    for (let i = 0; i < len; i++) {
      write[base + i * step] = read[base + dq[head]! * step]!
      if (dq[head] === i - r) head++
      if (i + r + 1 < len) push(i + r + 1)
    }
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
 * enough to a disc for a prefilter. Both passes are monotonic deques, because this is sized by the
 * *area* rather than by the anchor lattice -- so it is the one part of the anchor scan that does not
 * get cheaper when the lattice is coarsened, and on a 198 km2 region the naive scan was 51 seconds,
 * 14% of the entire run, for 51 comparisons per cell per axis.
 *
 * No-data is carried as +Infinity through both passes and turned back at the end. That reproduces
 * what the naive version did with its `v < m || isNaN(m)` test -- a hole is ignored while any real
 * value is in the window, and only an entirely empty window comes back empty -- without a NaN,
 * which no comparison the deque makes would order correctly.
 */
export function minFilter(src: Grid, radius: number): Grid {
  const r = Math.max(0, Math.round(radius / src.res))
  const { w, h } = src
  const mid = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  for (let i = 0; i < out.length; i++) {
    const v = src.data[i]!
    out[i] = Number.isNaN(v) ? Infinity : v
  }
  const dq = new Int32Array(Math.max(w, h))
  slidingMin(out, mid, h, w, w, 1, r, dq)
  slidingMin(mid, out, w, h, 1, w, r, dq)
  for (let i = 0; i < out.length; i++) if (out[i] === Infinity) out[i] = NaN
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
