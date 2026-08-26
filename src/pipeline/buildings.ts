import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { blitGrid, type Grid } from '../shared/grid.js'
import { RoofMask } from '../shared/anchoring.js'
import { levelFaces, rasteriseFaces } from '../shared/lod1.js'
import { gridForTile } from './downsample.js'

/**
 * Fetches the LoD1 city model per tile and stands the ground on its roofs.
 *
 * See src/shared/lod1.ts for what the data is and why it is this rather than the surface model.
 * The short version is cost: this is 5-50 KB per tile where the surface model is 33 MB, and three
 * quarters of Brandenburg's tiles have a building on them, so "only fetch the surface model where
 * there are buildings" saves a quarter of nothing.
 *
 * Tiles with no buildings have no file at all, so a 404 is the emptiness test and costs one
 * request with an error page for a body. It is cached as an empty file so a re-run does not ask
 * again.
 */

const BASE = 'https://data.geobasis-bb.de/geobasis/daten/3d_gebaeude/lod1_gml'
const CACHE_DIR = new URL('../../data/cache/', import.meta.url).pathname

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * One tile's CityGML, or an empty string where the survey publishes none.
 *
 * Retried like the raster tiles and for the same reason: a run touches hundreds of tiles and a
 * single reset socket should not cost the whole thing. A 404 is an answer, not a failure.
 */
async function tileGml(tile: string): Promise<string> {
  await mkdir(CACHE_DIR, { recursive: true })
  const path = join(CACHE_DIR, `lod1_${tile}.gml`)
  if (await exists(path)) return readFile(path, 'utf8')

  const url = `${BASE}/lod1_${tile}.zip`
  let last: unknown
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url)
      if (res.status === 404) {
        await writeFile(path, '')
        return ''
      }
      if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
      const entries = unzipSync(new Uint8Array(await res.arrayBuffer()))
      const name = Object.keys(entries).find((k) => k.endsWith('.gml'))
      if (!name) throw new Error(`no .gml inside ${url}`)
      const gml = Buffer.from(entries[name]!).toString('utf8')
      await writeFile(path, gml)
      return gml
    } catch (e) {
      last = e
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)))
    }
  }
  throw new Error(`${url} failed after 5 attempts: ${last}`)
}

export interface BuildingsApplied {
  /** Tiles that carry at least one building. */
  tiles: string[]
  /**
   * Roof cells found per tile, including tiles whose terrain was never loaded.
   *
   * Those are the interesting ones. The coarse pre-pass judges a tile on bare terrain, so a flat
   * square with a thirty-metre building on it is skipped before the city model is ever consulted --
   * and until this was counted there was no way to see how much that costs. Probing a skipped tile
   * is 5-50 KB and answers it exactly.
   */
  cellsPerTile: Map<string, number>
  /**
   * Which cells the ground was raised at, so later stages can still tell a roof from a hill once
   * the two have been merged into one grid. Anchoring depends on the difference -- see rigRange.
   */
  mask: RoofMask
}

/**
 * Raises a region's ground onto its roofs, in place.
 *
 * `max` rather than the roof outright, because a LoD1 roof is a single flattened height and the
 * terrain under a building on a slope can sit above it at one corner. Same rule as the browser's
 * `standingGround`, so a planned line and a found one measure the same thing.
 *
 * Only the tiles the terrain was actually loaded for, since a roof blitted over an unloaded tile
 * would be a building floating on nothing.
 */
export async function raiseOntoBuildings(
  ground: Grid,
  /** Every tile of the region. All are probed, so a skipped one still reports its buildings. */
  tiles: string[],
  /** The subset whose terrain was loaded. Only these are raised: a roof over unloaded terrain
   * would be a building standing on nothing. */
  raiseOn: Set<string>,
): Promise<BuildingsApplied> {
  // Eight at a time: these are small requests against one server, and a region can be hundreds of
  // tiles, so serial would spend minutes on the first run doing nothing but waiting.
  const queue = [...tiles]
  const roofs: { tile: string; grid: Grid }[] = []
  await Promise.all(
    Array.from({ length: Math.min(8, queue.length) }, async () => {
      for (let tile = queue.pop(); tile; tile = queue.pop()) {
        const faces = levelFaces(await tileGml(tile))
        if (!faces.length) continue
        const grid = gridForTile(tile, 1)
        rasteriseFaces(faces, grid)
        roofs.push({ tile, grid })
      }
    }),
  )

  const mask = RoofMask.sharedFor(ground)
  const cellsPerTile = new Map<string, number>()
  for (const { tile, grid } of roofs) {
    let cells = 0
    for (const v of grid.data) if (!Number.isNaN(v)) cells++
    cellsPerTile.set(tile, cells)
    if (!raiseOn.has(tile)) continue
    mask.add(grid)
    blitGrid(grid, ground)
  }
  return { tiles: roofs.map((r) => r.tile).sort(), mask, cellsPerTile }
}
