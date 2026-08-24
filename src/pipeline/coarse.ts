import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Grid } from '../shared/grid.js'
import { blitGeoTiff } from '../shared/geotiff.js'

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
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res2 = await fetch(url)
      if (!res2.ok) throw new Error(`HTTP ${res2.status}`)
      const buf = Buffer.from(await res2.arrayBuffer())
      await writeFile(path, buf)
      console.log(`${(buf.byteLength / 1024).toFixed(0)} KB`)
      return buf
    } catch (e) {
      last = e
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)))
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
 * measuring relief. Relief over a large window does not discriminate: the Sperenberg and Chorin
 * areas and a measured dead-flat rectangle all exceed 16 m of it. What separates them is how
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
 * Dilated by one tile. A line reaches up to `maxLength` from its anchor, so it can cross into a
 * neighbouring tile; without the dilation an accepted anchor's line would run into unloaded terrain
 * and be silently dropped. One tile is 1 km, comfortably more than `maxLength`.
 */
export function tilesWorthLoading(drop: Grid, minDrop: number): Set<string> {
  const seeds = new Set<string>()
  for (let y = 0; y < drop.h; y++) {
    for (let x = 0; x < drop.w; x++) {
      const v = drop.data[y * drop.w + x]!
      if (Number.isNaN(v) || v < minDrop) continue
      const e = drop.e0 + (x + 0.5) * drop.res
      const n = drop.n1 - (y + 0.5) * drop.res
      seeds.add(`${Math.floor(e / 1000)}_${Math.floor(n / 1000)}`)
    }
  }
  const out = new Set<string>()
  for (const key of seeds) {
    const [e, n] = key.split('_').map(Number) as [number, number]
    for (let de = -1; de <= 1; de++) for (let dn = -1; dn <= 1; dn++) out.add(`33${e + de}-${n + dn}`)
  }
  return out
}

/**
 * Aggregates a drop field to coarser cells for the map overlay, keeping the *greatest* drop in each.
 *
 * Max rather than mean so the overlay never claims ground was rejected more confidently than it was:
 * a cell shown below the threshold really had nothing above it anywhere inside.
 */
export function aggregateDrops(
  drop: Grid,
  res: number,
): { e: number; n: number; drop: number }[] {
  const step = Math.max(1, Math.round(res / drop.res))
  const out: { e: number; n: number; drop: number }[] = []
  for (let y = 0; y < drop.h; y += step) {
    for (let x = 0; x < drop.w; x += step) {
      let best = NaN
      for (let j = y; j < Math.min(drop.h, y + step); j++) {
        for (let i = x; i < Math.min(drop.w, x + step); i++) {
          const v = drop.data[j * drop.w + i]!
          if (!Number.isNaN(v) && (Number.isNaN(best) || v > best)) best = v
        }
      }
      if (Number.isNaN(best)) continue
      out.push({
        e: drop.e0 + (x + step / 2) * drop.res,
        n: drop.n1 - (y + step / 2) * drop.res,
        drop: Math.round(best * 10) / 10,
      })
    }
  }
  return out
}
