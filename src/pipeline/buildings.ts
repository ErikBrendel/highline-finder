import { inflateSync } from 'node:zlib'
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Grid, blitGrid } from '../shared/grid.js'
import { ensureDownsampled, gridForTile, loadTile } from './downsample.js'

/**
 * Where the buildings are, so the search can stand on them.
 *
 * The terrain model is bare earth and runs straight through a house; the surface model knows the
 * roof is there but cannot tell a roof from a tree. Neither answers "may an anchor stand here" on
 * its own. ALKIS -- the cadastre -- does, as a footprint polygon, and the survey serves it as a WMS
 * layer, which at one metre per pixel over a 1 km tile is exactly a mask for the tile's grid.
 *
 * Two things make this affordable:
 *
 *   1. The mask is cheap. A tile's PNG is 4-50 KB against 1.4 MB of terrain and 33 MB of surface,
 *      and it is fetched once and cached like any other tile.
 *   2. It says which tiles are worth the surface model. Most of Brandenburg has no buildings at
 *      all, and on those tiles nothing here costs anything beyond the mask itself. The surface
 *      model is only pulled for the tiles that do -- which is the same trick the corridor pass
 *      plays later, applied to a different question.
 *
 * Brandenburg only. Outside the state the service returns a valid, fully transparent image, so a
 * Berlin tile reports no buildings rather than an error -- see the Mueggelberge AOI.
 */

const WMS = 'https://isk.geobasis-bb.de/ows/alkis_wms'
const CACHE_DIR = new URL('../../data/cache/', import.meta.url).pathname

/** One pixel per metre over a 1 km tile, which is both the tile grid's resolution and its size. */
const SIDE = 1000

function url(tile: string): string {
  const [e, n] = tile.slice(2).split('-').map(Number) as [number, number]
  const e0 = e * 1000
  const n0 = n * 1000
  // EPSG:25833 is an easting/northing axis-order CRS, so WMS 1.3.0 wants BBOX in that order --
  // reversed, the service returns a blank image rather than an error.
  return (
    `${WMS}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=adv_alkis_gebaeude&STYLES=` +
    `&CRS=EPSG:25833&BBOX=${e0},${n0},${e0 + 1000},${n0 + 1000}` +
    `&WIDTH=${SIDE}&HEIGHT=${SIDE}&FORMAT=image/png&TRANSPARENT=TRUE`
  )
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Fetches and caches one tile's footprint PNG.
 *
 * Retried like the raster tiles and for the same reason: a run touches hundreds of tiles and a
 * single reset socket should not cost the whole thing.
 */
async function footprintPng(tile: string): Promise<Buffer> {
  await mkdir(CACHE_DIR, { recursive: true })
  const path = join(CACHE_DIR, `alkis_${tile}.png`)
  if (await exists(path)) return readFile(path)

  let last: unknown
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url(tile))
      if (!res.ok) throw new Error(`${url(tile)} -> HTTP ${res.status}`)
      const bytes = Buffer.from(await res.arrayBuffer())
      await writeFile(path, bytes)
      return bytes
    } catch (e) {
      last = e
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)))
    }
  }
  throw new Error(`${url(tile)} failed after 5 attempts: ${last}`)
}

/**
 * The alpha channel of an 8-bit RGBA PNG, one byte per pixel, rows north to south.
 *
 * A whole decoder would be a dependency; this is the one encoding the service actually returns,
 * asserted rather than assumed. Only alpha is kept: the cadastre draws footprints filled but in
 * several greys, and the only question here is covered or not.
 */
export function alphaOf(png: Buffer): Uint8Array {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let idat: Buffer[] = []
  let width = 0
  let height = 0
  for (let pos = 8; pos + 8 <= png.length; ) {
    const length = png.readUInt32BE(pos)
    const type = png.toString('ascii', pos + 4, pos + 8)
    const body = png.subarray(pos + 8, pos + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      const depth = body.readUInt8(8)
      const colour = body.readUInt8(9)
      if (depth !== 8 || colour !== 6) throw new Error(`unexpected PNG ${depth}-bit type ${colour}`)
    } else if (type === 'IDAT') {
      idat.push(body)
    }
    pos += 12 + length
  }

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const out = new Uint8Array(width * height)
  const line = Buffer.alloc(stride)
  const prev = Buffer.alloc(stride)
  for (let y = 0, at = 0; y < height; y++) {
    const filter = raw[at++]!
    raw.copy(line, 0, at, at + stride)
    at += stride
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? line[x - 4]! : 0
      const b = prev[x]!
      const c = x >= 4 ? prev[x - 4]! : 0
      let add = 0
      if (filter === 1) add = a
      else if (filter === 2) add = b
      else if (filter === 3) add = (a + b) >> 1
      else if (filter === 4) {
        const pp = a + b - c
        const pa = Math.abs(pp - a)
        const pb = Math.abs(pp - b)
        const pc = Math.abs(pp - c)
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      line[x] = (line[x]! + add) & 255
    }
    line.copy(prev)
    for (let x = 0; x < width; x++) out[y * width + x] = line[x * 4 + 3]!
  }
  return out
}

/** Half-covered pixels at a footprint edge count as building; the polygon is the truth, not the fill. */
const COVERED = 64

/** One tile's footprint mask, or null when the tile has no buildings at all. */
export async function footprintMask(tile: string): Promise<Uint8Array | null> {
  const alpha = alphaOf(await footprintPng(tile))
  let any = false
  const mask = new Uint8Array(alpha.length)
  for (let i = 0; i < alpha.length; i++) {
    if (alpha[i]! <= COVERED) continue
    mask[i] = 1
    any = true
  }
  return any ? mask : null
}

export interface BuildingsApplied {
  /** Tiles that carry at least one footprint, and so needed the surface model. */
  tiles: string[]
  /** Cells the ground was raised at. */
  cells: number
}

/**
 * Raises a region's ground onto its roofs, in place.
 *
 * The max rather than the surface outright, because the two products are from different epochs: a
 * house demolished since the aerial survey would otherwise pull the standing surface *below* the
 * terrain. Same rule as the browser's `standingGround`, so a planned line and a found one measure
 * the same thing.
 *
 * Only tiles with a footprint are given to the surface model, and only after their mask says so --
 * which is the whole performance story here, because the surface model is twenty-four times the
 * bytes of the terrain model and most tiles have nothing on them.
 */
export async function raiseOntoBuildings(
  ground: Grid,
  tiles: string[],
): Promise<BuildingsApplied> {
  const masks = new Map<string, Uint8Array>()
  // Eight at a time: these are small requests against one server, and a region can be hundreds of
  // tiles, so serial would spend minutes on the first run doing nothing but waiting.
  const queue = [...tiles]
  await Promise.all(
    Array.from({ length: Math.min(8, queue.length) }, async () => {
      for (let tile = queue.pop(); tile; tile = queue.pop()) {
        const mask = await footprintMask(tile)
        if (mask) masks.set(tile, mask)
      }
    }),
  )
  const withBuildings = [...masks.keys()].sort()
  if (!withBuildings.length) return { tiles: [], cells: 0 }

  await ensureDownsampled('bdom', withBuildings, 1)
  let cells = 0
  for (const tile of withBuildings) {
    const mask = masks.get(tile)!
    const surface = await loadTile('bdom', tile, 1)
    // A roof-only copy of the tile: NaN everywhere the cadastre says there is no building, so
    // blitGrid's keep-the-greater rule leaves the rest of the terrain untouched.
    const roofs = gridForTile(tile, 1)
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] !== 1) continue
      const v = surface.data[i]!
      if (Number.isNaN(v)) continue
      roofs.data[i] = v
      cells++
    }
    blitGrid(roofs, ground)
  }
  return { tiles: withBuildings, cells }
}
