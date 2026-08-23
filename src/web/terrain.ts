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

/** The UTM 33N square one window covers, for drawing it on the map. */
export function windowBounds(tx: number, ty: number): { e0: number; n0: number; size: number } {
  return { e0: tx * TILE, n0: ty * TILE, size: TILE }
}

export interface WindowEvent {
  tx: number
  ty: number
  state: 'loading' | 'loaded' | 'failed'
}

/**
 * Reports which elevation windows are being fetched, so the map can show it in place.
 *
 * A callback rather than React state: a drag can touch a dozen windows a second, and the overlay
 * animates per frame anyway, so routing this through a re-render would buy nothing.
 */
const listeners = new Set<(e: WindowEvent) => void>()

export function onWindowActivity(fn: (e: WindowEvent) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

const emit = (e: WindowEvent) => listeners.forEach((fn) => fn(e))

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
  emit({ tx, ty, state: 'loading' })
  try {
    await Promise.all(
      (['ground', 'surface'] as Layer[]).map(async (layer) => {
        const bytes = await fetchCached(url(layer, e0, n0))
        await blitGeoTiff(bytes, layer === 'ground' ? ground : surface)
      }),
    )
  } catch (e) {
    emit({ tx, ty, state: 'failed' })
    throw e
  }
  loaded.set(keyOf(tx, ty), { ground, surface })
  emit({ tx, ty, state: 'loaded' })
}

/**
 * Windows covering the corridor between two points, plus a margin for dragging.
 *
 * A band along the line, not its bounding box. The box is the same thing for an axis-aligned line
 * and quadratically worse for a diagonal one -- at the planner's 4 km span cap that is the
 * difference between roughly 60 windows and 320, each of them two requests, for area the line never
 * crosses. Walking the segment in half-window steps and taking the neighbours of each step covers
 * the same line with no gap: consecutive steps land at most half a window apart, so their
 * neighbourhoods always overlap.
 */
export function windowsFor(a: Pos, b: Pos, margin = TILE): [number, number][] {
  const steps = Math.ceil(Math.hypot(b.e - a.e, b.n - a.n) / (TILE / 2))
  const reach = Math.ceil(margin / TILE)
  const out = new Map<string, [number, number]>()
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps
    const cx = Math.floor((a.e + (b.e - a.e) * t) / TILE)
    const cy = Math.floor((a.n + (b.n - a.n) * t) / TILE)
    for (let dx = -reach; dx <= reach; dx++) {
      for (let dy = -reach; dy <= reach; dy++) out.set(`${cx + dx}_${cy + dy}`, [cx + dx, cy + dy])
    }
  }
  return [...out.values()]
}

/**
 * Fetches whatever is still missing around these points.
 *
 * Resolves to true only if something new arrived, so callers can re-measure on a real change
 * instead of on every call. Dragging an anchor asks for terrain many times a second and almost
 * always already has it; without this the answer would be indistinguishable from a fresh load.
 */
export async function ensureTerrain(a: Pos, b: Pos): Promise<boolean> {
  const missing = windowsFor(a, b).filter(([tx, ty]) => !loaded.has(keyOf(tx, ty)))
  if (!missing.length) return false
  await Promise.all(
    missing.map(([tx, ty]) => {
      const key = keyOf(tx, ty)
      let job = inFlight.get(key)
      if (!job) {
        job = loadWindow(tx, ty).finally(() => inFlight.delete(key))
        inFlight.set(key, job)
      }
      return job
    }),
  )
  return true
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
