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
    const { w, h, e0, n1, res } = this
    return { buffer: this.data.buffer as SharedArrayBuffer, w, h, e0, n1, res }
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
 * Sliding-window minimum over each of `lines` runs of `len` values, in van Herk's two scans.
 *
 * Cut the run into blocks the width of the window. Scan each block forwards keeping a running
 * minimum, and again backwards keeping another. A window is exactly one block wide, so it always
 * lands inside two neighbouring blocks -- and the answer for it is the smaller of the backward
 * minimum where it starts and the forward minimum where it ends. Three comparisons a cell, whatever
 * the radius, against the naive scan's one per cell of the window.
 *
 * `step` walks the axis being filtered and `lineStep` walks between lines, so a horizontal pass is
 * (1, w) and a vertical one is (w, 1). The vertical pass strides a 700 MB array, which sounds
 * ruinous and is not: both scans read straight through with a constant stride and touch each value
 * about twice, so the prefetcher keeps up. A monotonic deque, which is the other way to do this, was
 * measured at twice the cost here for the bookkeeping.
 */
function slidingMin(
  read: Float32Array,
  write: Float32Array,
  lines: number,
  len: number,
  lineStep: number,
  step: number,
  r: number,
  forward: Float32Array,
  backward: Float32Array,
): void {
  const window = 2 * r + 1
  for (let line = 0; line < lines; line++) {
    const base = line * lineStep
    for (let start = 0; start < len; start += window) {
      const end = Math.min(start + window, len)
      let m = Infinity
      for (let i = start; i < end; i++) {
        const v = read[base + i * step]!
        if (v < m) m = v
        forward[i] = m
      }
      m = Infinity
      for (let i = end - 1; i >= start; i--) {
        const v = read[base + i * step]!
        if (v < m) m = v
        backward[i] = m
      }
    }
    for (let i = 0; i < len; i++) {
      const from = i - r
      // Clamped at both ends rather than wrapped: a window hanging off the run covers the part of
      // it that is there, which is what the naive scan did with its Math.max/Math.min bounds.
      const to = i + r < len ? i + r : len - 1
      const ahead = forward[to]!
      const behind = from >= 0 ? backward[from]! : Infinity
      write[base + i * step] = behind < ahead ? behind : ahead
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
 * enough to a disc for a prefilter. It is sized by the *area* rather than by the anchor lattice, so
 * it is the one part of the anchor scan that does not get cheaper when the lattice is coarsened --
 * and on a 198 km2 region the naive scan was 51 seconds, 14% of the entire run.
 *
 * No-data is carried as +Infinity through both passes and turned back at the end. That reproduces
 * what the naive version did with its `v < m || isNaN(m)` test -- a hole is ignored while any real
 * value is in the window, and only an entirely empty window comes back empty -- without a NaN,
 * which no comparison the scans make would order correctly.
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
  const forward = new Float32Array(Math.max(w, h))
  const backward = new Float32Array(Math.max(w, h))
  slidingMin(out, mid, h, w, w, 1, r, forward, backward)
  slidingMin(mid, out, w, h, 1, w, r, forward, backward)
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
