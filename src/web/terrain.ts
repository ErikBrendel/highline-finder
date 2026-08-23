import { Grid, type Pos, type Sampler } from '../shared/grid.js'
import { blitGeoTiff } from '../shared/geotiff.js'
import { fetchCached } from './tileCache.js'

/**
 * Elevation on demand, for measuring user-placed lines.
 *
 * Nothing is bundled. The Brandenburg survey publishes both the terrain and the surface model as
 * WCS coverages over the whole state with open CORS, so a window is fetched for wherever the user
 * is actually working and cached in the same IndexedDB store as the basemap tiles. That is what
 * makes this survive the AOI growing: the payload depends on where you look, not on how large the
 * region is. Bundling the raster instead would have cost ~939 KB per square kilometre, or roughly
 * 28 GB for Brandenburg.
 *
 * One honest difference from the pipeline. The pipeline reads the 0.2 m surface model and reduces
 * it to 1 m by taking the *maximum* of each block, so the tallest obstacle in a cell wins. The WCS
 * resamples server side instead, and measured against the pipeline's rule it under-reports canopy
 * by more than a metre on 16 % of cells, occasionally by much more at canopy edges. So a planned
 * line's canopy figures are slightly optimistic compared with a found candidate's. Terrain, which
 * is the hard constraint, matches exactly.
 */

const WCS = 'https://isk.geobasis-bb.de/ows'
const LAYERS = {
  ground: { service: 'dgm_wcs', coverage: 'bb_dgm' },
  surface: { service: 'bdom_wcs', coverage: 'bb_bdom' },
} as const

/** Window size in metres. 256 keeps a request near 256 KB per layer and reuses well while dragging. */
const TILE = 256

type Layer = keyof typeof LAYERS

interface Window {
  ground: Grid
  surface: Grid
}

const loaded = new Map<string, Window>()
const inFlight = new Map<string, Promise<void>>()

const keyOf = (tx: number, ty: number) => `${tx}_${ty}`

function url(layer: Layer, e0: number, n0: number): string {
  const { service, coverage } = LAYERS[layer]
  return (
    `${WCS}/${service}?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage` +
    `&COVERAGEID=${coverage}&FORMAT=image/tiff` +
    `&SUBSET=x(${e0},${e0 + TILE})&SUBSET=y(${n0},${n0 + TILE})`
  )
}

async function loadWindow(tx: number, ty: number): Promise<void> {
  const e0 = tx * TILE
  const n0 = ty * TILE
  const ground = Grid.filled(TILE, TILE, e0, n0 + TILE, 1)
  const surface = Grid.filled(TILE, TILE, e0, n0 + TILE, 1)
  await Promise.all(
    (['ground', 'surface'] as Layer[]).map(async (layer) => {
      const bytes = await fetchCached(url(layer, e0, n0))
      await blitGeoTiff(bytes, layer === 'ground' ? ground : surface)
    }),
  )
  loaded.set(keyOf(tx, ty), { ground, surface })
}

/** Windows covering the corridor between two points, plus a margin for dragging. */
function windowsFor(a: Pos, b: Pos, margin = TILE): [number, number][] {
  const minE = Math.min(a.e, b.e) - margin
  const maxE = Math.max(a.e, b.e) + margin
  const minN = Math.min(a.n, b.n) - margin
  const maxN = Math.max(a.n, b.n) + margin
  const out: [number, number][] = []
  for (let tx = Math.floor(minE / TILE); tx <= Math.floor(maxE / TILE); tx++) {
    for (let ty = Math.floor(minN / TILE); ty <= Math.floor(maxN / TILE); ty++) {
      out.push([tx, ty])
    }
  }
  return out
}

/** Fetches whatever is still missing around these points. Resolves once everything is in memory. */
export async function ensureTerrain(a: Pos, b: Pos): Promise<void> {
  await Promise.all(
    windowsFor(a, b).map(([tx, ty]) => {
      const key = keyOf(tx, ty)
      if (loaded.has(key)) return undefined
      let job = inFlight.get(key)
      if (!job) {
        job = loadWindow(tx, ty).finally(() => inFlight.delete(key))
        inFlight.set(key, job)
      }
      return job
    }),
  )
}

function cellOf(layer: Layer, e: number, n: number): number {
  const win = loaded.get(keyOf(Math.floor(e / TILE), Math.floor(n / TILE)))
  return win ? win[layer].nearest(e, n) : NaN
}

/**
 * Samples across window boundaries by looking each contributing cell up independently, so a line
 * crossing from one fetched window into the next reads continuously instead of hitting an edge.
 */
function samplerFor(layer: Layer): Sampler {
  return {
    sample(e: number, n: number): number {
      const fx = e - 0.5
      const fy = n + 0.5
      const x0 = Math.floor(fx)
      const y0 = Math.floor(fy)
      const tx = fx - x0
      const ty = y0 - fy + 1
      const v00 = cellOf(layer, x0, y0)
      const v10 = cellOf(layer, x0 + 1, y0)
      const v01 = cellOf(layer, x0, y0 - 1)
      const v11 = cellOf(layer, x0 + 1, y0 - 1)
      if (Number.isNaN(v00 + v10 + v01 + v11)) return cellOf(layer, e, n)
      return v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty
    },
  }
}

export const groundSampler = samplerFor('ground')
export const surfaceSampler = samplerFor('surface')

export function terrainStats(): { windows: number } {
  return { windows: loaded.size }
}
