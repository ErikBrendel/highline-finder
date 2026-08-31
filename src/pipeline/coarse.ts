import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Grid, minFilter } from '../shared/grid.js'
import type { LevelFace } from '../shared/lod1.js'
import type { Params } from '../shared/types.js'
import { blitGeoTiff } from '../shared/geotiff.js'
import { ATTEMPTS, backoffMs } from './cache.js'

/**
 * A downsampled terrain grid, for deciding where it is worth looking at full resolution.
 *
 * The survey publishes the terrain model at 1 m only, but its WCS advertises the OGC scaling
 * extension, so any resolution is available on demand. Measured cost: ~1.3 KB per square kilometre
 * at 64 m and ~15 KB at 16 m, against 1.4 MB for the 1 m tiles and 33 MB for the surface model. That
 * three-orders-of-magnitude gap is the whole point -- a coarse pass over a region costs less than a
 * single full-resolution tile.
 *
 * Server time scales with the *source* area, not the output size: measured 0.5 s for a 2 km box,
 * 11.6 s for 10 km, 33.5 s for 20 km, and a timeout past 64 km. So requests are chunked, and each
 * chunk is cached on disk like the tiles are.
 */

const WCS = 'https://isk.geobasis-bb.de/ows/dgm_wcs'
const CACHE_DIR = new URL('../../data/cache/', import.meta.url).pathname
/** Chunk side in metres. 8 km is comfortably inside the point where the server starts timing out. */
const CHUNK = 8192

export interface Bounds {
  minE: number
  minN: number
  maxE: number
  maxN: number
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function chunkTiff(e0: number, n0: number, res: number): Promise<Buffer> {
  await mkdir(CACHE_DIR, { recursive: true })
  const path = join(CACHE_DIR, `coarse${res}_${e0}-${n0}.tif`)
  if (await exists(path)) return readFile(path)

  const url =
    `${WCS}?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage&COVERAGEID=bb_dgm&FORMAT=image/tiff` +
    `&SUBSET=x(${e0},${e0 + CHUNK})&SUBSET=y(${n0},${n0 + CHUNK})&SCALEFACTOR=${1 / res}`
  process.stdout.write(`  coarse ${res}m ${e0}-${n0} ... `)
  let last: unknown
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, backoffMs(attempt - 1)))
    let answer: Response
    try {
      answer = await fetch(url)
    } catch (e) {
      last = e
      continue
    }
    // A status is the server's answer, not a hiccup. The row of chunks north of the survey's
    // coverage replies 400 every time, and retrying each of them four times cost half a minute
    // apiece on a pass where they are 3% of the work.
    if (!answer.ok) throw new Error(`coarse ${res}m ${e0}-${n0}: HTTP ${answer.status}`)
    try {
      const buf = Buffer.from(await answer.arrayBuffer())
      await writeFile(path, buf)
      console.log(`${(buf.byteLength / 1024).toFixed(0)} KB`)
      return buf
    } catch (e) {
      last = e
    }
  }
  throw new Error(`coarse ${res}m ${e0}-${n0}: ${last}`)
}

/** Terrain over `bounds` at `res` metres, assembled from cached WCS chunks. */
export async function loadCoarse(bounds: Bounds, res: number): Promise<Grid> {
  const e0 = Math.floor(bounds.minE / res) * res
  const n1 = Math.ceil(bounds.maxN / res) * res
  const n0 = Math.floor(bounds.minN / res) * res
  const grid = Grid.filled(
    Math.ceil((Math.ceil(bounds.maxE / res) * res - e0) / res),
    Math.ceil((n1 - n0) / res),
    e0,
    n1,
    res,
  )
  for (let ce = Math.floor(bounds.minE / CHUNK) * CHUNK; ce < bounds.maxE; ce += CHUNK) {
    for (let cn = Math.floor(bounds.minN / CHUNK) * CHUNK; cn < bounds.maxN; cn += CHUNK) {
      const buf = await chunkTiff(ce, cn, res)
      await blitGeoTiff(
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
        grid,
      )
    }
  }
  return grid
}

/**
 * Greatest fall from each cell to any cell within `radius`, as a new grid.
 *
 * Mirrors the anchor scan's own gate -- `minDropDepth` within `dropSearchRadius` -- rather than
 * measuring relief. Relief over a large window does not discriminate: Tropical, Niederfinow and a
 * measured dead-flat rectangle all exceed 16 m of it. What separates them is how
 * steeply the ground falls, which is what this measures.
 *
 * Naive rather than separable, because a max-drop is not a separable operation and the grid is
 * small: 16 m cells over 137 km2 is half a million cells with a 2-cell reach.
 */
export function dropField(g: Grid, radius: number): Grid {
  const r = Math.max(1, Math.round(radius / g.res))
  const out = new Float32Array(g.w * g.h).fill(NaN)
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      const v = g.data[y * g.w + x]!
      if (Number.isNaN(v)) continue
      let drop = 0
      for (let j = Math.max(0, y - r), je = Math.min(g.h - 1, y + r); j <= je; j++) {
        for (let i = Math.max(0, x - r), ie = Math.min(g.w - 1, x + r); i <= ie; i++) {
          const u = g.data[j * g.w + i]!
          if (!Number.isNaN(u) && v - u > drop) drop = v - u
        }
      }
      out[y * g.w + x] = drop
    }
  }
  return new Grid(out, g.w, g.h, g.e0, g.n1, g.res)
}

/**
 * The 1 km tiles worth fetching at full resolution, from a coarse drop field.
 *
 * Two rules, because a single passing cell means nothing. A tile qualifies only when `minCoverage`
 * of its cells fall far enough -- a flat kilometre with three cells scraping past a threshold is a
 * ditch, not terrain worth a search, and taking any single cell as evidence let exactly that pull
 * in whole tiles. A fraction rather than a count so the rule does not change meaning when the
 * coarse resolution does.
 *
 * The result is then everything within `reach` of a passing cell in a qualified tile, not every
 * neighbour of a qualified tile. A line runs up to `maxLength` from its anchor and unloaded terrain
 * reads as absent rather than as an error, so the margin has to exist -- but growing it from the
 * cells that earned it keeps it far tighter than growing it from whole tiles.
 */
/**
 * Tiles carrying a roof you could anchor on, which the terrain rule cannot see.
 *
 * The pre-pass measures bare earth, and a LoD1 roof is not bare earth. Measured on the current
 * dataset, *every* urban line's anchors sit on cells the terrain rule reads as flat -- median 1.1 m
 * of drop against a 10 m threshold -- so all 3,629 of them exist only because a hill within 500 m
 * dragged their tile in. On the flat, which is most of Brandenburg, nothing would drag them in.
 *
 * The test has the same shape as the one the anchor scan will apply -- an anchor on a roof attaches
 * at roof level, so the ground within `dropSearchRadius` has to lie below it -- but a much higher
 * bar: `maskMinRoofDrop` rather than `minDropDepth`. At the scan's own threshold this rule pulled in
 * 96 of the 121 tiles on chunk 52_728 that the terrain rule had rejected, since one 10 m building
 * qualifies a tile and the result is then dilated, so a village claims its neighbourhood and the
 * pre-pass stops filtering anything. Deciding a tile is worth fetching at 1 m is a stricter question
 * than deciding a roof is worth anchoring on; see params.ts for what that trade gives up.
 *
 * The lowest nearby terrain is read off the same coarse grid the terrain rule uses, so this costs
 * one min-filter and no new data at all.
 *
 * Dilated by `reach` like the terrain set and for the same reason: a line from that roof runs up to
 * `maxLength` away, and the ground it crosses has to be loaded.
 */
export function tilesWithRoofAnchors(
  faces: Map<string, LevelFace[]>,
  coarse: Grid,
  p: Params,
  reach: number,
  /** Where a roof may be anchored on. Null means anywhere; see URBAN_AREAS. */
  urban: { covers(e: number, n: number): boolean } | null = null,
): Set<string> {
  const lowest = minFilter(coarse, p.dropSearchRadius)
  const out = new Set<string>()
  for (const [tile, tileFaces] of faces) {
    let anchorable = 0
    for (const { ring, z } of tileFaces) {
      // The ring's first corner is enough: a LoD1 footprint is small next to a 16 m coarse cell.
      if (urban && !urban.covers(ring[0]!, ring[1]!)) continue
      const near = lowest.nearest(ring[0]!, ring[1]!)
      if (!Number.isNaN(near) && z - near >= p.maskMinRoofDrop) anchorable++
    }
    if (anchorable < p.maskMinRoofs) continue
    const [te, tn] = tile.slice(2).split('-').map(Number) as [number, number]
    const span = Math.ceil(reach / 1000)
    for (let e = te - span; e <= te + span; e++) {
      for (let n = tn - span; n <= tn + span; n++) out.add(`33${e}-${n}`)
    }
  }
  return out
}

/**
 * The unit every fetching decision is taken in.
 *
 * The survey publishes in 1 km tiles, so a coarse pass at 16 m can conclude whatever it likes about
 * a hillside and still only act a whole tile at a time. Both the rule below and the overlay that
 * reports on it count on this lattice, so what the map shows is the number the rule read.
 */
export const TILE_M = 1000

const tileOf = (e: number, n: number) => `${Math.floor(e / TILE_M)}_${Math.floor(n / TILE_M)}`

/** The fixed denominator a tile's coverage is judged against. See tilesWorthLoading. */
export const cellsPerSourceTile = (res: number) => (TILE_M / res) ** 2

export function tilesWorthLoading(
  drop: Grid,
  minDrop: number,
  minCoverage: number,
  reach: number,
): Set<string> {
  const passes = new Map<string, number>()
  const passing: [number, number][] = []

  for (let y = 0; y < drop.h; y++) {
    for (let x = 0; x < drop.w; x++) {
      const v = drop.data[y * drop.w + x]!
      // Negated rather than `v < minDrop`, so a hole in the data is skipped rather than counted.
      // Both NaN and an out-of-range read compare false against everything, and the wrong sense of
      // this test silently promoted every hole to a passing cell.
      if (!(v >= minDrop)) continue
      const e = drop.e0 + (x + 0.5) * drop.res
      const n = drop.n1 - (y + 0.5) * drop.res
      passes.set(tileOf(e, n), (passes.get(tileOf(e, n)) ?? 0) + 1)
      passing.push([e, n])
    }
  }

  /**
   * A whole tile's worth of cells, not the number this window happened to see.
   *
   * Counting only what is in the window makes a tile's verdict depend on the shape of whatever asks
   * about it, which is exactly what a chunked pipeline cannot have. It cost real ground: the
   * Gollenberg at Otto Lilienthal has 46 passing cells in its tile, 1.2 % of it, and was fetched for
   * years only because the area of interest drawn around it clipped that tile to a 1000 x 490 m
   * sliver sitting on the valley -- within which the fraction looked like 9 %. The first chunk to
   * see the whole tile rejected it and the 65 lines there vanished.
   *
   * A tile only partly inside the window is now judged on the cells that are, against the full
   * denominator, so it is rejected rather than flattered. That is the conservative direction and
   * only reaches tiles at the very edge of a window, which chunks load a halo beyond anyway.
   */
  const cellsPerTile = cellsPerSourceTile(drop.res)

  const out = new Set<string>()
  for (const [e, n] of passing) {
    if ((passes.get(tileOf(e, n)) ?? 0) < cellsPerTile * minCoverage) continue
    for (let te = Math.floor((e - reach) / 1000); te <= Math.floor((e + reach) / 1000); te++) {
      for (let tn = Math.floor((n - reach) / 1000); tn <= Math.floor((n + reach) / 1000); tn++) {
        out.add(`33${te}-${tn}`)
      }
    }
  }
  return out
}

/**
 * The pre-pass's own verdict per source tile, for the map overlay: how many coarse cells qualified.
 *
 * The overlay used to be the drop field itself, aggregated to 128 m squares each holding the
 * steepest reading inside it. That was 819,000 squares over the ground covered so far -- four
 * million coordinate conversions and 19 MB to fetch, which is what hung the browser -- and it
 * answered a question the pipeline never asks. What decides a fetch is not how steep a spot is but
 * how *much* of a tile qualifies, against `maskMinCoverage`, and a max over 64 cells cannot be
 * turned back into that: one qualifying cell in 64 shows as a qualifying square, so any coverage
 * read off the old overlay was inflated by up to 64x against the very threshold it invited you to
 * compare it with.
 *
 * Counting the cells instead gives one square per source tile carrying the exact number the rule
 * read, which is both three hundred times less to draw and the actual answer.
 *
 * Tiles the window barely reaches get no verdict at all. A coarse grid is snapped outwards to its
 * own resolution, so a 10 km window overhangs by up to a cell and clips an eleventh row of tiles it
 * has seen 0.4 % of; the survey's coverage ends raggedly for real at the state border. Both would
 * be reported as rejected, since the denominator is a whole tile either way, and a fringe of black
 * squares around everything drawn is a claim made out of a sliver. Half the tile is the line: the
 * fetching rule still judges partial tiles the hard way -- see above, that is deliberate -- this
 * only declines to *draw* a verdict there.
 */
export function tilePasses(
  drop: Grid,
  minDrop: number,
): { e: number; n: number; passing: number }[] {
  const passing = new Map<string, number>()
  const measured = new Map<string, number>()
  for (let y = 0; y < drop.h; y++) {
    for (let x = 0; x < drop.w; x++) {
      const v = drop.data[y * drop.w + x]!
      if (Number.isNaN(v)) continue
      const key = tileOf(drop.e0 + (x + 0.5) * drop.res, drop.n1 - (y + 0.5) * drop.res)
      measured.set(key, (measured.get(key) ?? 0) + 1)
      // Same sense as tilesWorthLoading: a hole is not a passing cell.
      if (v >= minDrop) passing.set(key, (passing.get(key) ?? 0) + 1)
    }
  }
  const enough = cellsPerSourceTile(drop.res) / 2
  return [...measured]
    .filter(([, cells]) => cells >= enough)
    .map(([key]) => {
      const [te, tn] = key.split('_').map(Number) as [number, number]
      return {
        e: te * TILE_M + TILE_M / 2,
        n: tn * TILE_M + TILE_M / 2,
        passing: passing.get(key) ?? 0,
      }
    })
}
