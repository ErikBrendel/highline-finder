import type { GeoTIFFImage } from 'geotiff'
import type { Grid } from '../shared/grid.js'
import { latticeProjector, toWgs84 } from '../shared/geo.js'
import { proxied } from './hosts.js'

/**
 * Canopy height where no survey's surface model can be read: Meta and WRI's global map, v2.
 *
 * A model's estimate from satellite imagery, trained against airborne laser scans -- metres off in
 * places, and not one moment in time -- so a line measured against it says so (see `Canopy`). What
 * it does have is everything a state survey has not published to a browser, at a metre, under
 * CC BY 4.0. Trees only: buildings are not in it, so a roof is not seen at all.
 *
 * Published as one cloud-optimised GeoTIFF per zoom-10 Web Mercator tile, 190 MB each, of which a
 * window needs a few hundred kilobytes; those are range requests through the proxy, because the
 * bucket sends no CORS header.
 */

export const CANOPY_MAP_ATTRIBUTION = 'Canopy &copy; Meta, WRI (CC BY 4.0)'

const ZOOM = 10
const HALF = 20037508.342789244
const TILE = (2 * HALF) / 2 ** ZOOM
const PATH = '/forests/v2/global/dinov3_global_chm_v2_ml3/chm/'

const mercator = (e: number, n: number): [number, number] => {
  const { lat, lon } = toWgs84(e, n)
  return [(lon * HALF) / 180, Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) * 6378137]
}

/** The quadkey naming the file that holds a Web Mercator point. */
export function tileAt(x: number, y: number): string {
  const col = Math.floor((x + HALF) / TILE)
  const row = Math.floor((HALF - y) / TILE)
  let key = ''
  for (let z = ZOOM - 1; z >= 0; z--) key += ((col >> z) & 1) + 2 * ((row >> z) & 1)
  return key
}

const images = new Map<string, Promise<GeoTIFFImage>>()

function imageOf(key: string): Promise<GeoTIFFImage> {
  let job = images.get(key)
  if (!job) {
    job = import('geotiff').then(async ({ fromUrl }) =>
      (await fromUrl(proxied('chm', `${PATH}${key}.tif`), { allowFullFile: false })).getImage(),
    )
    job.catch(() => images.delete(key))
    images.set(key, job)
  }
  return job
}

/** A block of one tile's pixels, read once for every cell of the window that falls in it. */
interface Block {
  x0: number
  y0: number
  res: number
  w: number
  h: number
  data: Uint8Array
}

/**
 * Sets `surface` to `ground` plus the canopy the map estimates, for one window.
 *
 * Each cell takes the tallest of four samples a quarter metre either side of its centre: a map
 * pixel is about 0.7 m of ground at these latitudes, and the tallest thing in a cell is the one
 * that matters for clearance, the same rule `blitGeoTiff` uses for a survey's surface model.
 */
export async function estimateCanopy(ground: Grid, surface: Grid): Promise<void> {
  const size = ground.w * ground.res
  const n0 = ground.n1 - ground.h * ground.res
  const to = latticeProjector(mercator, ground.e0, n0, size)
  const corners = [to(ground.e0, n0), to(ground.e0 + size, n0), to(ground.e0, ground.n1), to(ground.e0 + size, ground.n1)]
  const xs = corners.map((c) => c[0])
  const ys = corners.map((c) => c[1])
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]

  const blocks = new Map<string, Block>()
  const keys = new Set([tileAt(minX, minY), tileAt(maxX, minY), tileAt(minX, maxY), tileAt(maxX, maxY)])
  await Promise.all(
    [...keys].map(async (key) => {
      const image = await imageOf(key)
      const [ox, oy] = image.getOrigin()
      const res = image.getResolution()[0]!
      const left = Math.max(0, Math.floor((minX - ox) / res) - 1)
      const top = Math.max(0, Math.floor((oy - maxY) / res) - 1)
      const right = Math.min(image.getWidth(), Math.ceil((maxX - ox) / res) + 1)
      const bottom = Math.min(image.getHeight(), Math.ceil((oy - minY) / res) + 1)
      if (right <= left || bottom <= top) return
      const [data] = (await image.readRasters({ window: [left, top, right, bottom] })) as unknown as Uint8Array[]
      blocks.set(key, { x0: ox! + left * res, y0: oy! - top * res, res, w: right - left, h: bottom - top, data: data! })
    }),
  )

  const height = (x: number, y: number): number => {
    const b = blocks.get(tileAt(x, y))
    if (!b) return NaN
    const c = Math.floor((x - b.x0) / b.res)
    const r = Math.floor((b.y0 - y) / b.res)
    return c < 0 || r < 0 || c >= b.w || r >= b.h ? NaN : b.data[r * b.w + c]!
  }
  const q = ground.res / 4
  for (let row = 0; row < ground.h; row++) {
    const n = ground.n1 - (row + 0.5) * ground.res
    for (let col = 0; col < ground.w; col++) {
      const i = row * ground.w + col
      const base = ground.data[i]!
      if (Number.isNaN(base)) continue
      const e = ground.e0 + (col + 0.5) * ground.res
      let top = 0
      for (const [de, dn] of [[-q, -q], [q, -q], [-q, q], [q, q]] as const) {
        const h = height(...to(e + de, n + dn))
        if (h > top) top = h
      }
      surface.data[i] = base + top
    }
  }
}
